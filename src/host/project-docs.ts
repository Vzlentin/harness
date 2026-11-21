/**
 * The parts of the store of the project that its modules share: the documents of the session, the entries of a message
 * and of its edits and deletes, the fold that applies them, the persons, the parleys, the asks, the lookup of an object
 * by its ID, the lookup of a parley by its slug, and the end of a contract.
 */
import type { ConversationId, Cursor, EntryId, EntryRecord, JsonObject, Tx } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import {
	type AskList,
	ASKS_KIND,
	type Author,
	MESSAGE_DELETE_KIND,
	MESSAGE_EDIT_KIND,
	MESSAGE_KIND,
	type Message,
	type Parley,
	type ParleyEnd,
	type ParleyList,
	PARLEYS_KIND,
	type PersonList,
	PERSONS_KIND,
} from "../protocol/project.ts";
import { boundedReplay } from "./checkpoint.ts";

/** The number of entries that one page of a scan of a thread gives. */
export const PAGE = 200;

/**
 * The data of the entry of a message. The entry has no model message: no model reads a thread. Its state is in the
 * outbox for a message out, and `received` for a message in.
 */
export type MessageData = Omit<Message, "id" | "thread" | "state">;

export const MessageEntry = durable.defineEntry<MessageData>(MESSAGE_KIND);

/**
 * The entry of an edit of the message `message`, in the conversation of its thread: the new data of the message. An
 * entry cannot change, so an edit is a later entry, and the message keeps its ID.
 */
export const MessageEditEntry = durable.defineEntry<MessageData & { message: number }>(MESSAGE_EDIT_KIND);

/** The entry of a delete of the message `message` by the caller `by`, in the conversation of its thread. */
export const MessageDeleteEntry = durable.defineEntry<{ message: number; by: string }>(MESSAGE_DELETE_KIND);

/**
 * Applies `entry`, an entry of a thread in ID order, to `messages`, the data of each message by ID: a message entry adds
 * a message, an edit replaces the data of its message, and a delete removes its message. An edit or a delete of a
 * message that is not there, and an entry of another kind, change nothing. The map keeps the messages in ID order.
 */
export function foldMessage(messages: Map<number, MessageData>, entry: EntryRecord): void {
	if (MessageEntry.is(entry)) messages.set(entry.id, entry.data);
	else if (MessageEditEntry.is(entry)) {
		const { message, ...data } = entry.data;

		if (messages.has(message)) messages.set(message, data);
	} else if (MessageDeleteEntry.is(entry)) messages.delete(entry.data.message);
}

/** The message `id` as its edits leave it, with the ID of its thread and the data of each message of the thread. */
export type FoundMessage = { thread: ConversationId; data: MessageData; messages: Map<number, MessageData> };

/**
 * The message `id` in `tx`, with the edits and deletes of its thread applied. No message with this ID, and a message
 * that a delete removed, fail with `Unknown message: <id>`.
 */
export async function knownMessage(tx: Tx, id: number): Promise<FoundMessage> {
	const entry = await tx.entry(MessageEntry, entryId(id));

	if (entry === undefined) throw new Error(`Unknown message: ${id}`);
	const messages = await scanMessages(tx, entry.conversationId);
	const data = messages.get(id);

	if (data === undefined) throw new Error(`Unknown message: ${id}`);

	return { thread: entry.conversationId, data, messages };
}

/** The data of each message of the thread `thread` in `tx`, by ID in ID order. */
async function scanMessages(tx: Tx, thread: ConversationId): Promise<Map<number, MessageData>> {
	const messages = new Map<number, MessageData>();
	let cursor: Cursor | undefined;

	do {
		const page = await tx.scanEntries({ conversationId: thread, order: "ascending" }, PAGE, cursor);

		for (const entry of page.items) foldMessage(messages, entry);
		cursor = page.next;
	} while (cursor !== undefined);

	return messages;
}

export const Persons = sessionDoc<PersonList>(PERSONS_KIND, () => ({ persons: [] }));

export const Parleys = sessionDoc<ParleyList>(PARLEYS_KIND, () => ({ parleys: [] }));

export const Asks = sessionDoc<AskList>(ASKS_KIND, () => ({ asks: [] }));

/** A document of the session of the kind `kind`, which starts as `initial()`. */
export function sessionDoc<T extends JsonObject>(kind: string, initial: () => T) {
	return durable.defineDoc<T>({ kind, version: 1, scope: "session", checkpointWhen: boundedReplay, initial });
}

/** The item `id` of `items`. An ID of no item fails with `Unknown <name>: <id>`. */
export function known<T extends { readonly id: number }>(items: readonly T[], id: number, name: string): T {
	const item = items.find((found) => found.id === id);

	if (item === undefined) throw new Error(`Unknown ${name}: ${id}`);

	return item;
}

/**
 * Ends the contract `parley` of `parleys` with the status `status` for the caller `by`: it replaces the parley in place,
 * and gives a copy of the ended parley.
 */
export function endContract(
	parleys: Parley[],
	parley: Readonly<Extract<Parley, { design_sense: string }>>,
	status: ParleyEnd,
	by: string,
): Parley {
	const ended: Parley = { ...parley, status, at: Date.now(), by };
	parleys[parleys.indexOf(parley)] = ended;

	return Value.Clone(ended);
}

/** The parley `slug` of `parleys`. A slug of no parley fails with `Unknown parley: <slug>`. */
export function knownParley(parleys: readonly Parley[], slug: string): Parley {
	const parley = parleys.find((found) => found.slug === slug);

	if (parley === undefined) throw new Error(`Unknown parley: ${slug}`);

	return parley;
}

/** Fails when `author` is a person that the store does not have. */
export async function knownAuthor(tx: Tx, author: Author): Promise<void> {
	if (author !== "user") known((await tx.doc(Persons)).persons, author, "person");
}

export function entryId(id: number): EntryId {
	// SAFETY: the store gives `undefined` for an ID of no message entry.
	return id as EntryId;
}
