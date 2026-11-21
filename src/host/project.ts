/**
 * The store of the project: the persons that the user talks with, the threads of messages with them, the tool calls
 * that the gate held, and the parleys and their asks. The rules are in `project-rules.ts`. Each list is one document of
 * the session, and each thread is an ownerless conversation whose entries are its messages, and the edits and deletes
 * of its messages, which a read applies in order. The states of the messages out are in the outbox, a document of the
 * session, because an entry cannot change. The requests of the host change them with these functions, each in its own
 * commit. A round and a contract also write the `shapes` edge of their parley to a work item, and a contract that
 * shapes an open item does not end.
 */
import type { Context } from "@earendil-works/chord/context";
import type { CommitChange, ConversationId, Cursor, DocumentReader, Harness, Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import {
	type AnswerAuthor,
	type AnswerInput,
	type Ask,
	askAnswerText,
	type AskList,
	type AskOption,
	type AskRef,
	type AskRound,
	askTransition,
	type AskWrite,
	HELD_KIND,
	type HeldAction,
	type HeldInput,
	type HeldList,
	isReadBack,
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
	type Parley,
	type ParleyAsks,
	type ParleyEnd,
	type ParleyFrame,
	type ParleyList,
	parleyText,
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
import { type Todo, todoLine } from "../protocol/todo.ts";
import type { ItemIndex } from "./item-index.ts";
import { itemForContract, openContractItems, writeEdge } from "./items.ts";
import {
	Asks,
	endContract,
	foldMessage,
	known,
	knownAuthor,
	knownMessage,
	knownParley,
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
import { addSaveTodos, closeSaveTodo } from "./save-todo.ts";
import { dropParleyAnswers, queueAnswers, type UserAnswerInput } from "./user-answers.ts";

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
	(await tx.doc(Asks)).asks.push(...file.asks);
}

/** A parley in the status `open`. */
type OpenParley = Extract<Parley, { readonly status: "open" }>;

/** An ask in the state `answered`. */
type AnsweredAsk = Extract<Ask, { readonly state: "answered" }>;

/** The fields of an ask without its state and its answer. */
type AskBase = Omit<Extract<Ask, { readonly state: "open" }>, "state">;

/**
 * Writes the round `round` with the caller `by` as the asker of its asks, and gives the write: the parley with all of
 * its asks, or the new asks when they have no parley. With `round.parley`, a new slug makes an open parley, which needs a title and a goal, and a known slug must be
 * an open parley, whose fields the frame replaces. With `round.item`, the round also writes the edge
 * `parley:<slug> shapes item:<item>` with the checks of `item link`. The asks of a parley take the next numbers of that
 * parley.
 */
export async function writeRound(tx: Tx, round: AskRound, by: string): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const asks = (await tx.doc(Asks)).asks;
	const at = Date.now();
	const parley = round.parley === undefined ? undefined : frameParley(parleys, round.parley, at, by);

	if (parley !== undefined && round.item !== undefined) {
		await writeEdge(tx, { from: `parley:${parley.slug}`, kind: "shapes", to: `item:${round.item}` }, by);
	}

	let n = parley === undefined ? 0 : lastNumber(asks, parley.id);
	const written: Ask[] = [];

	for (const input of round.asks) {
		const ask: Ask = { id: nextId(asks), title: input.title, state: "open", asker: by, at, by };

		if (input.kind !== undefined) ask.kind = input.kind;

		if (input.tension !== undefined) ask.tension = input.tension;

		if (input.options !== undefined) ask.options = input.options.map(copyOption);

		if (input.plan !== undefined) ask.plan = input.plan;

		if (input.view !== undefined) ask.view = input.view;

		if (parley !== undefined) {
			n += 1;
			ask.parley = { id: parley.id, n };
		}

		asks.push(ask);
		written.push(Value.Clone(ask));
	}

	return writeReply(parleys, asks, parley === undefined ? [] : [parley.id], written);
}

/**
 * Writes the answers `answers` of `author` for the caller `by`, and gives the write: each parley of the answered asks,
 * with all of its asks, and the answered asks with no parley. Each answer names its ask by ID, or by its number in a parley, and
 * two answers of one ask fail. Each answer replaces the answer of its ask, with its label and its words, as one unit. The answer `ok` to the read-back of
 * a parley, an ask of the parley with no options, makes the parley a contract, once every answer is written: each other
 * ask of the parley must be answered or dropped, and its `design_sense` set. A contract that shapes no item gets a new
 * item with its title and the edge `shapes`: `items` gives the items that each parley shapes. The same commit queues the answers for
 * their askers: one delivery for each asker and parley, with the text of the parley, and one for each answered ask with
 * no parley. An ask whose asker is `by` gets no delivery. When the host has a vault at this answer, it also adds the
 * todo `Save to the vault` of each answered ask to the list of its asker, where `root` is the project agent, and the
 * delivery of the ask ends with the line of that todo.
 */
export async function answerAsks(
	tx: Tx,
	answers: readonly AnswerInput[],
	by: string,
	author: AnswerAuthor,
	root: ConversationId,
	items: Pick<ItemIndex, "itemsOf">,
): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const asks = (await tx.doc(Asks)).asks;
	const at = Date.now();
	const written: Ask[] = [];
	const readBacks = new Set<number>();

	for (const input of answers) {
		const ask = resolveAsk(parleys, asks, input);

		if (written.some((each) => each.id === ask.id)) throw new Error(`Ask ${ask.id} has two answers in one write`);
		const parley = ask.parley === undefined ? undefined : openParley(known(parleys, ask.parley.id, "parley"));

		if (askTransition(ask.state, "answer") === undefined)
			throw new Error(`Ask ${ask.id} is ${ask.state}: it takes no answer`);
		const keys = answerKeys(ask);

		if (input.answer !== "own" && !keys.includes(input.answer)) {
			throw new Error(`Ask ${ask.id} takes ${keys.length === 0 ? "own" : `${keys.join(", ")} or own`}`);
		}

		const answered: AnsweredAsk = { ...askBase(ask), state: "answered", answer: input.answer, at, by, author };

		if (input.label !== undefined) answered.label = input.label;

		if (input.words !== undefined) answered.words = [...input.words];
		asks[asks.indexOf(ask)] = answered;
		written.push(Value.Clone(answered));

		if (parley !== undefined && input.answer === "ok") readBacks.add(parley.id);
	}

	for (const id of readBacks) await itemForContract(tx, makeContract(parleys, asks, id, at, by), by, items);

	const added = await addSaveTodos(tx, root, written);
	await queueAnswers(tx, deliveries(parleys, asks, written, by, added));
	const touched = written.flatMap((ask) => (ask.parley === undefined ? [] : [ask.parley.id]));

	return writeReply(parleys, asks, touched, written);
}

/**
 * The reply of a write: each parley of `ids`, once, in ID order, with all of its asks in `asks`, and the asks of
 * `written` with no parley.
 */
function writeReply(parleys: readonly Parley[], asks: readonly Ask[], ids: readonly number[], written: readonly Ask[]) {
	const changed = [...new Set(ids)].sort((a, b) => a - b);

	return {
		parleys: changed.map((id) => ({ parley: Value.Clone(known(parleys, id, "parley")), asks: parleyAsks(asks, id) })),
		asks: written.filter((ask) => ask.parley === undefined),
	} satisfies AskWrite;
}

/**
 * The deliveries of the answered asks `written` to their askers other than `by`, in the order of `written`: one for
 * each asker and parley, with the text of the parley in `parleys` and `asks`, and one for each ask with no parley. Each
 * delivery ends with the line of each todo of `added` that belongs to one of its asks.
 */
function deliveries(
	parleys: readonly Parley[],
	asks: readonly Ask[],
	written: readonly Ask[],
	by: string,
	added: readonly Todo[],
): UserAnswerInput[] {
	const queued: UserAnswerInput[] = [];
	const byParley = new Map<string, number[]>();

	for (const ask of written) {
		if (ask.asker === by) continue;

		if (ask.parley === undefined) {
			queued.push({ asker: ask.asker, delivery: { source: "ask", ask: ask.id, text: askAnswerText(ask) } });
			continue;
		}

		const key = `${ask.asker}\n${ask.parley.id}`;
		const found = byParley.get(key);

		if (found !== undefined) {
			found.push(ask.id);
			continue;
		}

		const parley = known(parleys, ask.parley.id, "parley");
		const text = parleyText({ parley, asks: parleyAsks(asks, parley.id) });
		const ids = [ask.id];
		byParley.set(key, ids);
		queued.push({ asker: ask.asker, delivery: { source: "parley", parley: parley.slug, asks: ids, text } });
	}

	return queued.map(({ asker, delivery }) => {
		const ids = delivery.source === "parley" ? delivery.asks : [delivery.ask];
		const mine = added.filter((todo) => todo.ask !== undefined && ids.includes(todo.ask));

		return {
			asker,
			delivery: { ...delivery, text: delivery.text + mine.map((todo) => `${todoLine(todo)}\n`).join("") },
		};
	});
}

/**
 * Drops the open ask of `ref` for the caller `by`, and gives the write: its parley with all of its asks, or the ask
 * when it has no parley. The ask of a parley that is not open does not change.
 */
export async function dropAsk(tx: Tx, ref: AskRef, by: string): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const asks = (await tx.doc(Asks)).asks;
	const ask = resolveAsk(parleys, asks, ref);

	if (ask.parley !== undefined) openParley(known(parleys, ask.parley.id, "parley"));

	if (askTransition(ask.state, "drop") === undefined)
		throw new Error(`Ask ${ask.id} is ${ask.state}: only an open ask drops`);
	const dropped: Ask = { ...askBase(ask), state: "dropped", at: Date.now(), by };
	asks[asks.indexOf(ask)] = dropped;

	return writeReply(parleys, asks, ask.parley === undefined ? [] : [ask.parley.id], [Value.Clone(dropped)]);
}

/**
 * Sets `note`, the ID of a note in the vault, on the ask of `ref` for the caller `by`, and gives the ask. Only the asker
 * of the ask records its note. An ask in any state takes a note, also in a parley that is not open, and a second note
 * replaces the first. The note sets the todo `Save to the vault` of the ask to done, unless the asker dropped it.
 */
export async function noteAsk(tx: Tx, ref: AskRef, note: string, by: string): Promise<Ask> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const ask = resolveAsk(parleys, (await tx.doc(Asks)).asks, ref);

	if (ask.asker !== by) throw new Error(`Ask ${ask.id} was asked by another caller: only its asker records its note`);
	Object.assign(ask, { note, at: Date.now(), by });
	await closeSaveTodo(tx, ask);

	return Value.Clone(ask);
}

/**
 * Makes the caller `by` the asker of the open asks of the parley `slug`, and gives the parley and its asks. The parley
 * is open or a contract: a contract has no open ask, so its take changes no ask. The answers of the parley that wait in
 * the queue go: the reply has them, and no asker gets them after the take.
 */
export async function takeParley(tx: Tx, slug: string, by: string): Promise<ParleyAsks> {
	const parley = knownParley((await tx.doc(Parleys)).parleys, slug);

	if (parley.status !== "contract") openParley(parley);
	const asks = (await tx.doc(Asks)).asks;
	const at = Date.now();

	for (const ask of asks) {
		if (ask.parley?.id === parley.id && ask.state === "open") Object.assign(ask, { asker: by, at, by });
	}

	await dropParleyAnswers(tx, parley.slug);

	return { parley: Value.Clone(parley), asks: parleyAsks(asks, parley.id) };
}

/**
 * Ends the contract `slug` with the status `status` for the caller `by`, and gives the parley. A contract that shapes
 * an open item fails: the close of its last item ends it. `items` gives the items that the contract shapes.
 */
export async function endParley(
	tx: Tx,
	slug: string,
	status: ParleyEnd,
	by: string,
	items: Pick<ItemIndex, "itemsOf">,
): Promise<Parley> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const parley = knownParley(parleys, slug);

	if (parley.status !== "contract") throw new Error(`Parley ${slug} is ${parley.status}: only a contract ends`);
	const open = await openContractItems(tx, slug, items);

	if (open.length > 0) {
		throw new Error(`Parley ${slug} shapes open items ${open.join(", ")}: close them, and the contract ends`);
	}

	return endContract(parleys, parley, status, by);
}

/** The parleys, in ID order. */
export async function readParleys(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<ParleyList> {
	const list = await reader.snapshot(Parleys, context);

	return { parleys: Value.Clone(list?.parleys ?? []) };
}

/** Every ask, in ID order. */
export async function readAsks(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<AskList> {
	const list = await reader.snapshot(Asks, context);

	return { asks: Value.Clone(list?.asks ?? []) };
}

/** The open asks, in ID order. */
export async function readOpenAsks(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<AskList> {
	return { asks: (await readAsks(reader, context)).asks.filter((ask) => ask.state === "open") };
}

/** The ask of `ref`, in any state. */
export async function readAsk(reader: Pick<DocumentReader, "snapshot">, ref: AskRef, context: Context): Promise<Ask> {
	const { parleys } = await readParleys(reader, context);

	return resolveAsk(parleys, (await readAsks(reader, context)).asks, ref);
}

/** The parley `slug` and its asks, in the order of their numbers. */
export async function readParley(
	reader: Pick<DocumentReader, "snapshot">,
	slug: string,
	context: Context,
): Promise<ParleyAsks> {
	const parley = knownParley((await readParleys(reader, context)).parleys, slug);

	return { parley, asks: parleyAsks((await readAsks(reader, context)).asks, parley.id) };
}

/**
 * The open parley of the frame `frame`, written at `at` by the caller `by`: a new parley for a new slug, or the known
 * parley with the fields of the frame.
 */
function frameParley(parleys: Parley[], frame: ParleyFrame, at: number, by: string): OpenParley {
	const { slug } = frame;
	const existing = parleys.find((parley) => parley.slug === slug);
	const found = existing === undefined ? undefined : openParley(existing);
	const title = frame.title ?? found?.title;
	const goal = frame.goal ?? found?.goal;

	if (title === undefined) throw new Error(`Parley ${slug} is new: title is required`);

	if (goal === undefined) throw new Error(`Parley ${slug} is new: goal is required`);
	const parley: OpenParley = { id: found?.id ?? nextId(parleys), slug, title, goal, status: "open", at, by };
	const evidence = frame.evidence ?? found?.evidence;
	const designSense = frame.design_sense ?? found?.design_sense;

	if (evidence !== undefined) parley.evidence = [...evidence];

	if (designSense !== undefined) parley.design_sense = designSense;

	if (found === undefined) parleys.push(parley);
	else parleys[parleys.indexOf(found)] = parley;

	return Value.Clone(parley);
}

/**
 * Makes the parley `id` a contract at `at` for the caller `by`, and gives the contract. It needs `design_sense`, and no
 * open ask.
 */
function makeContract(parleys: Parley[], asks: readonly Ask[], id: number, at: number, by: string): Parley {
	const parley = openParley(known(parleys, id, "parley"));
	const { design_sense } = parley;

	if (design_sense === undefined) {
		throw new Error(`Parley ${parley.slug} cannot be a contract: design_sense is not set`);
	}

	const open = asks.find((ask) => ask.parley?.id === id && ask.state === "open");

	if (open?.parley !== undefined) {
		throw new Error(`Parley ${parley.slug} cannot be a contract: ask ${open.parley.n} is open`);
	}

	const contract: Parley = { ...parley, status: "contract", design_sense, at, by };
	parleys[parleys.indexOf(parley)] = contract;

	return contract;
}

/** `parley` when it is open. A parley in another status fails: its asks do not change. */
function openParley(parley: Parley): OpenParley {
	if (parley.status !== "open") throw new Error(`Parley ${parley.slug} is ${parley.status}: its asks do not change`);

	return parley;
}

/** The ask of `ref` in `asks`: the ask of its ID, or the ask of its number in its parley. */
function resolveAsk<T extends Ask>(parleys: readonly Parley[], asks: readonly T[], ref: AskRef): T {
	if (ref.id !== undefined) return known(asks, ref.id, "ask");
	const parley = knownParley(parleys, ref.slug);
	const ask = asks.find((found) => found.parley?.id === parley.id && found.parley.n === ref.n);

	if (ask === undefined) throw new Error(`Parley ${parley.slug} has no ask ${ref.n}`);

	return ask;
}

/** The highest number of the asks of the parley `id`, or 0 when it has none. */
function lastNumber(asks: readonly Ask[], id: number): number {
	return Math.max(0, ...asks.flatMap((ask) => (ask.parley?.id === id ? [ask.parley.n] : [])));
}

/** Copies of the asks of the parley `id`, in the order of their numbers. */
function parleyAsks(asks: readonly Ask[], id: number): Ask[] {
	return asks.flatMap((ask) => (ask.parley?.id === id ? [Value.Clone(ask)] : []));
}

/** The fields of `ask` without its state, its answer and the author of its answer. */
function askBase(ask: Ask): AskBase {
	if (ask.state !== "answered") {
		const { state: _state, ...base } = ask;

		return base;
	}

	const { state: _state, author: _author, answer: _answer, label: _label, words: _words, ...base } = ask;

	return base;
}

/** The keys that `ask` takes besides `own`: the keys of its options, or `ok` when it is the read-back of a parley. */
function answerKeys(ask: Ask): string[] {
	if (isReadBack(ask)) return ["ok"];

	return ask.options?.map((option) => option.key) ?? [];
}

/** A copy of `option` with only the fields of an option. */
function copyOption(option: AskOption): AskOption {
	const copy: AskOption = { key: option.key, label: option.label };

	if (option.gains !== undefined) copy.gains = [...option.gains];

	if (option.costs !== undefined) copy.costs = [...option.costs];

	return copy;
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
