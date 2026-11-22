/**
 * The objects of the project that its requests change: the persons, the threads, the messages and the held actions.
 * They are in the project store (`project-store.ts`), and each function writes them in the transaction of a write. The
 * rules are in `project-rules.ts`, the asks in `asks.ts` and the parleys in `parleys.ts`. A load of a store file writes
 * the parleys and the asks into `durable.sqlite`.
 */
import type { CommitChange, Tx } from "@earendil-works/pi-durable";
import type { EntryAsks } from "../host/entries.ts";
import {
	ASKS_KIND,
	type HeldAction,
	type HeldInput,
	type Message,
	type MessageDelete,
	type MessageEdit,
	type MessageLog,
	type MessageMarkInput,
	messageTransition,
	type Person,
	type PersonAdd,
	type Thread,
	type ThreadAdd,
	type ThreadJoin,
	type ThreadMessages,
} from "../protocol/project.ts";
import type { FileMessage, StoreFile } from "../protocol/store-file.ts";
import { approveDelivery, approveKey } from "./project-deliveries.ts";
import { Parleys } from "./project-docs.ts";
import { releaseSource } from "./project-rules.ts";
import { knownAuthor, replyMessage, type StoreReader, type StoreTx } from "./project-store.ts";

/** The kinds of the documents of the project in `durable.sqlite`. */
const PROJECT_DOCS: ReadonlySet<string> = new Set([ASKS_KIND, Parleys.definition.kind]);

/** Whether `change` can change an object of the project in `durable.sqlite`: a document of the project. */
export function projectChange(change: CommitChange): boolean {
	return change.type === "document" && PROJECT_DOCS.has(change.record.kind);
}

/** Adds a person with the next ID, and gives it. */
export function addPerson(tx: StoreTx, input: PersonAdd): Person {
	return tx.addPerson({ name: input.name });
}

/** Adds a thread with `persons` and the next ID, and gives it. */
export function addThread(tx: StoreTx, input: ThreadAdd): Thread {
	for (const id of input.persons) tx.person(id);

	return tx.addThread({ topic: input.topic, persons: input.persons });
}

/** Adds the person `input.person` to the thread `input.id`, and gives the thread. A person of the thread fails. */
export function joinThread(tx: StoreTx, input: ThreadJoin): Thread {
	tx.person(input.person);
	const thread = tx.thread(input.id);

	if (thread.persons.includes(input.person)) throw new Error(`Person ${input.person} is already in thread ${input.id}`);
	tx.joinThread(thread.id, input.person);

	return { ...thread, persons: [...thread.persons, input.person] };
}

/**
 * Adds a message to the thread `input.thread`, with the state `received` for a message in and `draft` for a message out,
 * or `sent` for a message out with `input.state` `sent`, logged by the caller `by`, and gives it. `at` defaults to now.
 * The `last` of the thread becomes `at` when `at` is later. A message in from a person of the thread is a reply to each
 * message out of the thread that waits and is not later: a draft becomes `sent`, and a sent message `answered`.
 */
export function logMessage(tx: StoreTx, input: MessageLog, by: string): Message {
	if (input.state === "sent" && input.direction === "in") throw new Error("Only a message out can be logged as sent");
	const thread = tx.thread(input.thread);
	knownAuthor(tx, input.from);
	const at = input.at ?? Date.now();
	const fields = { thread: thread.id, from: input.from, at, text: input.text, by };

	const message =
		input.direction === "out"
			? tx.addMessage({ ...fields, direction: "out", state: input.state ?? "draft", changed: { at, by } })
			: tx.addMessage({ ...fields, direction: "in", state: "received" });

	if (input.direction === "in" && input.from !== "user" && thread.persons.includes(input.from)) {
		reply(tx, thread.id, at, by);
	}

	tx.setLast(thread.id, Math.max(thread.last ?? at, at));

	return replyMessage(message);
}

/**
 * Changes the text of the message `input.message`, and its time and author when they are given, for the caller `by`,
 * who becomes its `by`, and gives it. The message keeps its ID. Its direction is `out` for `user` and `in` for a
 * person, who must be a person of the thread. A message that keeps its direction keeps its state and its last change
 * of state. A message out that becomes a message in gets the state `received`, and a message in that becomes a message
 * out gets the state `draft`, changed at its time, as `logMessage` gives it. The edit moves no other message. The `last`
 * of the thread becomes the latest time of its messages.
 */
export function editMessage(tx: StoreTx, input: MessageEdit, by: string): Message {
	const found = tx.message(input.message);
	const thread = tx.thread(found.thread);
	const from = input.from ?? found.from;

	if (input.from !== undefined && from !== "user" && !thread.persons.includes(from))
		throw new Error(`Person ${from} is not in thread ${thread.id}`);
	const at = input.at ?? found.at;
	const fields = { id: found.id, thread: thread.id, from, at, text: input.text, by };
	let message: FileMessage;

	if (from !== "user") message = { ...fields, direction: "in", state: "received" };
	else if (found.direction === "out")
		message = { ...fields, direction: "out", state: found.state, changed: found.changed };
	else message = { ...fields, direction: "out", state: "draft", changed: { at, by } };

	tx.putMessage(message);
	setLast(tx, thread.id);

	return replyMessage(message);
}

/**
 * Removes the message `input.message`, and gives it as it was. A rule that is not retired and has it as its source
 * fails the delete, and a retired rule with it as its source loses its source. The `last` of the thread becomes the
 * latest time of the messages that remain, and goes when none remains.
 */
export function deleteMessage(tx: StoreTx, input: MessageDelete): Message {
	const found = tx.message(input.message);
	releaseSource(tx, found.id);
	tx.removeMessage(found.id);
	setLast(tx, found.thread);

	return replyMessage(found);
}

/** Sets the `last` of the thread `thread` to the latest time of its messages, or removes it when there is none. */
function setLast(tx: StoreTx, thread: number): void {
	const times = tx.messages(thread).map((message) => message.at);

	tx.setLast(thread, times.length === 0 ? undefined : Math.max(...times));
}

/** Moves each message out of the thread `thread` that is not later than `at` with a reply by the caller `by`. */
function reply(tx: StoreTx, thread: number, at: number, by: string): void {
	const now = Date.now();

	for (const out of tx.outMessages(thread)) {
		const state = out.at <= at ? messageTransition(out.state, "reply") : undefined;

		if (state !== undefined) tx.putMessage({ ...out, state, changed: { at: now, by } });
	}
}

/**
 * Marks the message out `input.message` with `input.state` for the caller `by`, and gives it. A message in, and a mark
 * that its state cannot take, fail.
 */
export function markMessage(tx: StoreTx, input: MessageMarkInput, by: string): Message {
	const { message: id } = input;
	const out = tx.message(id);

	if (out.direction === "in") throw new Error(`Message ${id} is a message in: only a message out has a mark`);
	const state = messageTransition(out.state, input.state);

	if (state === undefined) throw new Error(`Message ${id} is ${out.state}: it cannot become ${input.state}`);
	const marked: FileMessage = { ...out, state, changed: { at: Date.now(), by } };
	tx.putMessage(marked);

	return replyMessage(marked);
}

/**
 * Marks each message out of `ids` that the mark `sent` can change as sent by the caller `by`. An ID of another message,
 * or of no message, changes nothing.
 */
export function markSent(tx: StoreTx, ids: readonly number[], by: string): void {
	const at = Date.now();

	for (const out of tx.outMessages()) {
		const state = ids.includes(out.id) ? messageTransition(out.state, "sent") : undefined;

		if (state !== undefined) tx.putMessage({ ...out, state, changed: { at, by } });
	}
}

/**
 * Holds the call `input` of its agent with the state `held`, and gives the held action. A held or dropped action of the
 * same agent and request ID is given again, and no action is added.
 */
export function holdAction(tx: StoreTx, input: HeldInput): HeldAction {
	const found = heldFor(tx.held(), input.agent, input.requestId);

	if (found !== undefined) return found;

	return tx.addHeld({ ...input, state: "held", at: Date.now(), by: input.agent });
}

/** The call that an approved action can run for. */
type RunCall = Pick<HeldInput, "agent" | "tool" | "command" | "requestId">;

/**
 * Approves the held action `id` for the caller `by`, and gives it. An action that is not held fails. When `by` is not
 * the agent of the action, the same write adds the delivery that tells the agent: an agent that approves its own action,
 * such as a Pi session with a UI, calls it again by itself.
 */
export function approveHeld(tx: StoreTx, id: number, by: string): HeldAction {
	const approved = decide(tx, id, { state: "approved", by });

	if (by !== approved.agent) tx.addDelivery(approveDelivery(approved));

	return approved;
}

/** Drops the held action `id` for the caller `by`, and gives it. An action that is not held fails. */
export function dropHeld(tx: StoreTx, id: number, by: string): HeldAction {
	return decide(tx, id, { state: "dropped", by });
}

/**
 * Drops each action of `agent` in the state `held`, for the caller `agent`, and gives the dropped actions. A repeat
 * changes nothing.
 */
export function dropHeldOf(tx: StoreTx, agent: string): HeldAction[] {
	return tx
		.held()
		.filter((found) => found.state === "held" && found.agent === agent)
		.map((found) => decide(tx, found.id, { state: "dropped", by: agent }));
}

/**
 * Marks the approved action of the call `call` as run by it, and gives it: the action of the same agent, tool and
 * command that ran for no call, or for this call. The first run removes the delivery of its approve. With no such
 * action, it gives `undefined` and changes nothing.
 */
export function runApproved(tx: StoreTx, call: RunCall): HeldAction | undefined {
	const found = tx.held().find((held) => runsFor(held, call));

	if (found === undefined || found.ran !== undefined) return found;
	const ran: HeldAction = { ...found, ran: { requestId: call.requestId, at: Date.now() } };
	tx.putHeld(ran);
	tx.removeDelivery(approveKey(found.id));

	return ran;
}

/**
 * Whether the held action `held` is approved for the agent, tool and command of `call`, and lets it run: it ran for no
 * call, or for this one.
 */
function runsFor(held: HeldAction, call: RunCall): held is Extract<HeldAction, { readonly state: "approved" }> {
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

/** The thread `id` and its messages, oldest first. */
export function readThread(store: StoreReader, id: number): ThreadMessages {
	return { thread: store.thread(id), messages: store.messages(id).map(replyMessage) };
}

/**
 * Writes the parleys and the asks (in `asks`) of `file` in `tx`, into a store whose lists are empty. The persons, the
 * threads, the messages, the rules and the held actions go to the project store.
 */
export async function loadLists(tx: Tx, asks: Pick<EntryAsks, "load">, file: StoreFile): Promise<void> {
	(await tx.doc(Parleys)).parleys.push(...file.parleys);
	await asks.load(tx, file.asks);
}

/** Sets the held action `id` to the decision `decision`, and gives it. An action that is not held fails. */
function decide(
	tx: StoreTx,
	id: number,
	decision: Pick<Extract<HeldAction, { readonly state: "approved" | "dropped" }>, "state" | "by">,
): HeldAction {
	const found = tx.heldAction(id);

	if (found.state !== "held") throw new Error(`Held action ${id} is ${found.state}, not held`);
	const decided: HeldAction = { ...found, ...decision, at: Date.now() };
	tx.putHeld(decided);

	return decided;
}
