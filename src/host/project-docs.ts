/**
 * The parts of the store of the project that its modules share: the documents of the session, the entry of a message,
 * the persons, and the lookup of an object by its ID.
 */
import type { EntryId, JsonObject, Tx } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { type Author, MESSAGE_KIND, type Message, type PersonList, PERSONS_KIND } from "../protocol/project.ts";

/**
 * The data of the entry of a message. The entry has no model message: no model reads a thread. Its state is in the
 * outbox for a message out, and `received` for a message in.
 */
export type MessageData = Omit<Message, "id" | "thread" | "state">;

export const MessageEntry = durable.defineEntry<MessageData>(MESSAGE_KIND);

export const Persons = sessionDoc<PersonList>(PERSONS_KIND, () => ({ persons: [] }));

/** A document of the session of the kind `kind`, which starts as `initial()`. */
export function sessionDoc<T extends JsonObject>(kind: string, initial: () => T) {
	return durable.defineDoc<T>({ kind, version: 1, scope: "session", checkpointWhen: () => false, initial });
}

/** The item `id` of `items`. An ID of no item fails with `Unknown <name>: <id>`. */
export function known<T extends { readonly id: number }>(items: readonly T[], id: number, name: string): T {
	const item = items.find((found) => found.id === id);

	if (item === undefined) throw new Error(`Unknown ${name}: ${id}`);

	return item;
}

/** Fails when `author` is a person that the store does not have. */
export async function knownAuthor(tx: Tx, author: Author): Promise<void> {
	if (author !== "user") known((await tx.doc(Persons)).persons, author, "person");
}

export function entryId(id: number): EntryId {
	// SAFETY: the store gives `undefined` for an ID of no message entry.
	return id as EntryId;
}
