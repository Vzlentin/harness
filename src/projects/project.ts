/**
 * The store of the project: the persons that the user talks with, the threads of messages with them, and the tool calls
 * that the gate held. The rules are in `project-rules.ts`, the asks in `asks.ts` and the parleys in `parleys.ts`. Each
 * list is one document of the session, and each thread is an ownerless conversation whose entries are its messages, and
 * the edits and deletes of its messages, which a read applies in order. The states of the messages out are in the
 * outbox, a document of the session, because an entry cannot change. The requests of the host change them with these
 * functions, each in its own commit. A load of a store file writes all of these lists.
 */
import type { Context } from "@earendil-works/chord/context";
import type { CommitChange, ConversationId, Cursor, DocumentReader, Harness, Tx } from "@earendil-works/pi-durable";
import { Asks, loadAsks } from "../host/asks.ts";
import {
	HELD_KIND,
	type HeldAction,
	type HeldInput,
	type HeldList,
	MESSAGE_DELETE_KIND,
	MESSAGE_EDIT_KIND,
	MESSAGE_KIND,
	type Message,
	type MessageDelete,
	type MessageEdit,
	type MessageLog,
	type MessageMarkInput,
	type MessageState,
	messageTransition,
	OUTBOX_KIND,
	type Person,
	type PersonAdd,
	type PersonList,
	RULES_KIND,
	type Thread,
	type ThreadAdd,
	type ThreadJoin,
	type ThreadList,
	type ThreadMessages,
	THREADS_KIND,
} from "../protocol/project.ts";
import type { StoreFile } from "../protocol/store-file.ts";
import {
	foldMessage,
	known,
	knownAuthor,
	knownMessage,
	MessageDeleteEntry,
	type MessageData,
	MessageEditEntry,
	MessageEntry,
	PAGE,
	Parleys,
	Persons,
	sessionDoc,
} from "./project-docs.ts";
import { loadRules, releaseSource } from "./project-rules.ts";

const Threads = sessionDoc<ThreadList>(THREADS_KIND, () => ({ threads: [] }));
const Held = sessionDoc<HeldList>(HELD_KIND, () => ({ held: [] }));
const Outbox = sessionDoc<{ messages: OutState[] }>(OUTBOX_KIND, () => ({ messages: [] }));

/** A message with no state: the data of its entry, its ID and its thread. */
export type StoredMessage = MessageData & { id: number; thread: number };

/**
 * The state of the message out `id` of the thread `thread`, written at `written`, and changed last at `at` by the caller
 * `by`.
 */
export type OutState = { id: number; thread: number; state: MessageState; written: number; at: number; by: string };

/** The kinds of the entries of a thread: a message, and an edit or a delete of a message. */
const MESSAGE_KINDS: ReadonlySet<string> = new Set([MESSAGE_KIND, MESSAGE_EDIT_KIND, MESSAGE_DELETE_KIND]);

/** The kinds of the documents of the project. A message is an entry, not a document; its state out is in the outbox. */
const PROJECT_DOCS: ReadonlySet<string> = new Set([
	RULES_KIND,
	...[Persons, Threads, Held, Parleys, Asks, Outbox].map((doc) => doc.definition.kind),
]);

/** Whether `change` can change an object of the project: a message, or a document of the project. */
export function projectChange(change: CommitChange): boolean {
	switch (change.type) {
		case "entry":
			return MESSAGE_KINDS.has(change.value.kind);
		case "document":
			return PROJECT_DOCS.has(change.record.kind);
		default:
			return false;
	}
}

/** Adds a person with the next ID of the list, and gives it. */
export async function addPerson(tx: Tx, input: PersonAdd): Promise<Person> {
	const list = await tx.doc(Persons);
	const person: Person = { id: nextId(list.persons), name: input.name };
	list.persons.push({ ...person });

	return person;
}

/** Adds a thread with `persons` in a new ownerless conversation, whose ID is the ID of the thread, and gives it. */
export async function addThread(tx: Tx, input: ThreadAdd): Promise<Thread> {
	const persons = await tx.doc(Persons);

	for (const id of input.persons) known(persons.persons, id, "person");
	const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
	const thread: Thread = { id: conversation.id, topic: input.topic, persons: [...input.persons] };
	(await tx.doc(Threads)).threads.push(copyThread(thread));

	return thread;
}

/** Adds the person `input.person` to the thread `input.id`, and gives the thread. A person of the thread fails. */
export async function joinThread(tx: Tx, input: ThreadJoin): Promise<Thread> {
	known((await tx.doc(Persons)).persons, input.person, "person");
	const thread = known((await tx.doc(Threads)).threads, input.id, "thread");

	if (thread.persons.includes(input.person)) throw new Error(`Person ${input.person} is already in thread ${input.id}`);
	thread.persons.push(input.person);

	return copyThread(thread);
}

/**
 * Adds a message to the thread `input.thread`, with the state `received` for a message in and `draft` for a message out,
 * or `sent` for a message out with `input.state` `sent`, logged by the caller `by`, and gives it. `at` defaults to now.
 * The `last` of the thread becomes `at` when `at` is later. A message in from a person of the thread is a reply to each
 * message out of the thread that waits and is not later: a draft becomes `sent`, and a sent message `answered`.
 */
export async function logMessage(tx: Tx, input: MessageLog, by: string): Promise<Message> {
	if (input.state === "sent" && input.direction === "in") throw new Error("Only a message out can be logged as sent");
	const thread = known((await tx.doc(Threads)).threads, input.thread, "thread");
	await knownAuthor(tx, input.from);
	const at = input.at ?? Date.now();
	const data: MessageData = { from: input.from, direction: input.direction, at, text: input.text, by };
	const outbox = await tx.doc(Outbox);
	const entry = await tx.appendEntry(MessageEntry, conversationId(input.thread), { data });
	thread.last = Math.max(thread.last ?? at, at);

	if (input.direction === "out") {
		const state = input.state ?? "draft";
		outbox.messages.push({ id: entry.id, thread: input.thread, state, written: at, at, by });
	} else if (input.from !== "user" && thread.persons.includes(input.from)) reply(outbox.messages, input.thread, at, by);

	return joinMessage({ id: entry.id, thread: input.thread, ...data }, outStates(outbox.messages));
}

/**
 * Changes the text of the message `input.message`, and its time and author when they are given, for the caller `by`,
 * who becomes its `by`, and gives it. The message keeps its ID. Its direction is `out` for `user` and `in` for a
 * person, who must be a person of the thread. A message that keeps its direction keeps its state, and a message out
 * gets `at` as its time written. A message out that becomes a message in leaves the outbox, and a message in that
 * becomes a message out gets the state `draft`, as `logMessage` gives it. The edit moves no other message. The `last`
 * of the thread becomes the latest time of its messages.
 */
export async function editMessage(tx: Tx, input: MessageEdit, by: string): Promise<Message> {
	const { message: id } = input;
	const found = await knownMessage(tx, id);
	const thread = known((await tx.doc(Threads)).threads, found.thread, "thread");
	const from = input.from ?? found.data.from;

	if (input.from !== undefined && from !== "user" && !thread.persons.includes(from))
		throw new Error(`Person ${from} is not in thread ${thread.id}`);
	const at = input.at ?? found.data.at;
	const data: MessageData = { from, direction: from === "user" ? "out" : "in", at, text: input.text, by };
	const outbox = (await tx.doc(Outbox)).messages;
	const out = outbox.find((row) => row.id === id);

	if (out !== undefined && data.direction === "in") outbox.splice(outbox.indexOf(out), 1);
	else if (out !== undefined) out.written = at;
	else if (data.direction === "out") {
		const next = outbox.findIndex((row) => row.id > id);
		const row: OutState = { id, thread: thread.id, state: "draft", written: at, at, by };
		outbox.splice(next === -1 ? outbox.length : next, 0, row);
	}

	foldMessage(found.messages, await tx.appendEntry(MessageEditEntry, found.thread, { data: { message: id, ...data } }));
	setLast(thread, found.messages);

	return joinMessage({ id, thread: thread.id, ...data }, outStates(outbox));
}

/**
 * Removes the message `input.message` for the caller `by`, with its row of the outbox, and gives it as it was. A rule
 * that is not retired and has it as its source fails the delete, and a retired rule with it as its source loses its
 * source. The `last` of the thread becomes the latest time of the messages that remain, and goes when none remains.
 */
export async function deleteMessage(tx: Tx, input: MessageDelete, by: string): Promise<Message> {
	const { message: id } = input;
	const found = await knownMessage(tx, id);
	const thread = known((await tx.doc(Threads)).threads, found.thread, "thread");
	await releaseSource(tx, id);
	const outbox = (await tx.doc(Outbox)).messages;
	const message = joinMessage({ id, thread: thread.id, ...found.data }, outStates(outbox));
	const out = outbox.findIndex((row) => row.id === id);

	if (out !== -1) outbox.splice(out, 1);
	foldMessage(found.messages, await tx.appendEntry(MessageDeleteEntry, found.thread, { data: { message: id, by } }));
	setLast(thread, found.messages);

	return message;
}

/** Sets the `last` of `thread` to the latest time of `messages`, or removes it when there is no message. */
function setLast(thread: Thread, messages: ReadonlyMap<number, MessageData>): void {
	const times = [...messages.values()].map((message) => message.at);

	if (times.length === 0) delete thread.last;
	else thread.last = Math.max(...times);
}

/** Moves each message out of the thread `thread` that was written at `at` or before with a reply by the caller `by`. */
function reply(messages: OutState[], thread: number, at: number, by: string): void {
	const now = Date.now();

	for (const out of messages) {
		const state = out.thread === thread && out.written <= at ? messageTransition(out.state, "reply") : undefined;

		if (state !== undefined) Object.assign(out, { state, at: now, by });
	}
}

/**
 * Marks the message out `input.message` with `input.state` for the caller `by`, and gives it. A message in, and a mark
 * that its state cannot take, fail.
 */
export async function markMessage(tx: Tx, input: MessageMarkInput, by: string): Promise<Message> {
	const { message: id } = input;
	const found = await knownMessage(tx, id);
	const out = (await tx.doc(Outbox)).messages.find((row) => row.id === id);

	if (out === undefined) throw new Error(`Message ${id} is a message in: only a message out has a mark`);
	const state = messageTransition(out.state, input.state);

	if (state === undefined) throw new Error(`Message ${id} is ${out.state}: it cannot become ${input.state}`);
	Object.assign(out, { state, at: Date.now(), by });

	return joinMessage({ id, thread: out.thread, ...found.data }, outStates([out]));
}

/**
 * Marks each message out of `ids` that the mark `sent` can change as sent by the caller `by`. An ID of another message,
 * or of no message, changes nothing.
 */
export async function markSent(tx: Tx, ids: readonly number[], by: string): Promise<void> {
	const at = Date.now();

	for (const out of (await tx.doc(Outbox)).messages) {
		const state = ids.includes(out.id) ? messageTransition(out.state, "sent") : undefined;

		if (state !== undefined) Object.assign(out, { state, at, by });
	}
}

/** The state of each message out, in ID order. */
export async function readOutbox(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<OutState[]> {
	const list = await reader.snapshot(Outbox, context);

	return (list?.messages ?? []).map((out) => ({ ...out }));
}

/**
 * Holds the call `input` of its agent with the state `held`, and gives the held action. A held or dropped action of the
 * same agent and request ID is given again, and no action is added.
 */
export async function holdAction(tx: Tx, input: HeldInput): Promise<HeldAction> {
	const list = await tx.doc(Held);
	const found = heldFor(list.held, input.agent, input.requestId);

	if (found !== undefined) return copyHeld(found);
	const held: HeldAction = { id: nextId(list.held), ...input, state: "held", at: Date.now(), by: input.agent };
	list.held.push(copyHeld(held));

	return held;
}

/** The call that an approved action can run for. */
type RunCall = Pick<HeldInput, "agent" | "tool" | "command" | "requestId">;

/** Approves the held action `id` for the caller `by`, and gives it. An action that is not held fails. */
export async function approveHeld(tx: Tx, id: number, by: string): Promise<HeldAction> {
	return decide(tx, id, { state: "approved", by });
}

/** Drops the held action `id` for the caller `by`, and gives it. An action that is not held fails. */
export async function dropHeld(tx: Tx, id: number, by: string): Promise<HeldAction> {
	return decide(tx, id, { state: "dropped", by });
}

/**
 * Marks the approved action of the call `call` as run by it, and gives it: the action of the same agent, tool and
 * command that ran for no call, or for this call. With no such action, it gives `undefined` and changes nothing.
 */
export async function runApproved(tx: Tx, call: RunCall): Promise<HeldAction | undefined> {
	const list = await tx.doc(Held);
	const found = list.held.find((held) => runsFor(held, call));

	if (found === undefined) return undefined;
	const ran: HeldAction = { ...found, ran: found.ran ?? { requestId: call.requestId, at: Date.now() } };
	list.held[list.held.indexOf(found)] = copyHeld(ran);

	return ran;
}

/**
 * Whether the held action `held` is approved for the agent, tool and command of `call`, and lets it run: it ran for no
 * call, or for this one.
 */
export function runsFor(held: HeldAction, call: RunCall): held is Extract<HeldAction, { readonly state: "approved" }> {
	return (
		held.state === "approved" &&
		held.agent === call.agent &&
		held.tool === call.tool &&
		held.command === call.command &&
		(held.ran === undefined || held.ran.requestId === call.requestId)
	);
}

/** The held or dropped action of the call `requestId` of `agent`. */
export function heldFor(held: readonly HeldAction[], agent: string, requestId: string): HeldAction | undefined {
	return held.find((found) => found.state !== "approved" && found.agent === agent && found.requestId === requestId);
}

/** The held actions, in ID order. */
export async function readHeld(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<HeldList> {
	const list = await reader.snapshot(Held, context);

	return { held: (list?.held ?? []).map(copyHeld) };
}

/** The persons, in ID order. */
export async function readPersons(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<PersonList> {
	const list = await reader.snapshot(Persons, context);

	return { persons: (list?.persons ?? []).map((person) => ({ ...person })) };
}

/** The threads, in ID order. */
export async function readThreads(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<ThreadList> {
	const list = await reader.snapshot(Threads, context);

	return { threads: (list?.threads ?? []).map(copyThread) };
}

/** The thread `id` and its messages, oldest first. */
export async function readThread(
	harness: Pick<Harness, "snapshot" | "conversation">,
	id: number,
	context: Context,
): Promise<ThreadMessages> {
	const thread = known((await readThreads(harness, context)).threads, id, "thread");

	return { thread, messages: await readMessages(harness, id, context) };
}

/** The messages of the thread `id`, oldest first, each with its state in the outbox. */
export async function readMessages(
	harness: Pick<Harness, "snapshot" | "conversation">,
	id: number,
	context: Context,
): Promise<Message[]> {
	// The outbox is read after the entries, so that each message out that they have has its state there.
	const stored = await readStored(harness, id, context);
	const states = outStates(await readOutbox(harness, context));

	return stored.map((message) => joinMessage(message, states));
}

/** The messages of the thread `id`, in ID order, with their edits and deletes applied, and with no state. */
export async function readStored(
	harness: Pick<Harness, "conversation">,
	id: number,
	context: Context,
): Promise<StoredMessage[]> {
	const conversation = await harness.conversation(conversationId(id), context);

	if (conversation === undefined) throw new Error(`Unknown thread: ${id}`);
	const messages = new Map<number, MessageData>();
	let cursor: Cursor | undefined;

	do {
		const page = await conversation.entries({ order: "ascending" }, PAGE, cursor, context);

		for (const entry of page.items) foldMessage(messages, entry);
		cursor = page.next;
	} while (cursor !== undefined);

	return [...messages].map(([message, data]) => ({ id: message, thread: id, ...data }));
}

/** The state of each message of `outbox`, by message ID. */
export function outStates(outbox: readonly OutState[]): ReadonlyMap<number, MessageState> {
	return new Map(outbox.map((out) => [out.id, out.state]));
}

/**
 * The message `message` with its state: `received` for a message in, and its state in `states` for a message out. A
 * message out has its state in the outbox from the commit that adds it, so a message out with no state fails.
 */
export function joinMessage(message: StoredMessage, states: ReadonlyMap<number, MessageState>): Message {
	if (message.direction === "in") return { ...message, state: "received" };
	const state = states.get(message.id);

	if (state === undefined) throw new Error(`Message ${message.id} is a message out with no state in the outbox`);

	return { ...message, state };
}

/**
 * Writes the lists of `file` in `tx`, into a store whose lists are empty. Each thread gets a new conversation and each
 * message a new entry, in file order, and the source of each rule gets the new ID of its message, and its thread the new
 * ID of the thread of that message. Each message out gets its state in the outbox, with its time as `written` and its
 * last change. `last` of the rules is the higher of the file and the store.
 */
export async function loadLists(tx: Tx, file: StoreFile): Promise<void> {
	const messageIds = new Map<number, { id: number; thread: number }>();
	const threads = await tx.doc(Threads);
	const outbox = await tx.doc(Outbox);

	for (const { messages, ...thread } of file.threads) {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		threads.threads.push(copyThread({ ...thread, id: conversation.id }));

		for (const message of messages) {
			const { from, direction, at, text, by } = message;
			const entry = await tx.appendEntry(MessageEntry, conversation.id, { data: { from, direction, at, text, by } });
			messageIds.set(message.id, { id: entry.id, thread: conversation.id });

			if (message.direction === "out") {
				const { state, changed } = message;
				outbox.messages.push({ id: entry.id, thread: conversation.id, state, written: at, ...changed });
			}
		}
	}

	(await tx.doc(Persons)).persons.push(...file.persons);
	await loadRules(tx, file.rules, file.lastRule, messageIds);
	(await tx.doc(Held)).held.push(...file.held);
	(await tx.doc(Parleys)).parleys.push(...file.parleys);
	await loadAsks(tx, file.asks);
}

function nextId(items: readonly { readonly id: number }[]): number {
	return (items.at(-1)?.id ?? 0) + 1;
}

/** Sets the held action `id` to the decision `decision`, and gives it. An action that is not held fails. */
async function decide(
	tx: Tx,
	id: number,
	decision: Pick<Extract<HeldAction, { readonly state: "approved" | "dropped" }>, "state" | "by">,
): Promise<HeldAction> {
	const list = await tx.doc(Held);
	const found = known(list.held, id, "held action");

	if (found.state !== "held") throw new Error(`Held action ${id} is ${found.state}, not held`);
	const decided: HeldAction = { ...found, ...decision, at: Date.now() };
	list.held[list.held.indexOf(found)] = copyHeld(decided);

	return decided;
}

function copyThread(thread: Thread): Thread {
	return { ...thread, persons: [...thread.persons] };
}

function copyHeld(held: HeldAction): HeldAction {
	return held.state === "approved" && held.ran !== undefined ? { ...held, ran: { ...held.ran } } : { ...held };
}

function conversationId(id: number): ConversationId {
	// SAFETY: a thread ID is the ID of the conversation that `addThread` created.
	return id as ConversationId;
}
