/**
 * The change of a watched conversation view that a watch line carries, and its two ends: the host makes it from the
 * chord ops of a commit, and a client applies it, so the client needs no chord. It imports only types, so the Pi
 * extension can load it.
 *
 * The entries of a change are the entries from one index to the end. This is correct because no op moves the entries
 * before the index where it starts: a splice starts at its index, a change in an entry at that entry, and a reorder or
 * a new array at the first entry.
 */
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationRecord, ConversationView, EntryRecord, JsonObject } from "@earendil-works/pi-durable";

/**
 * The parts of a watched view that changed, as whole values: the entries from index `from` on, the documents that
 * changed by kind (`null` for a removed document), and the conversation record. A part that did not change is absent.
 */
export type ViewParts = {
	readonly entries?: { readonly from: number; readonly items: readonly EntryRecord[] };
	readonly docs?: Readonly<Record<string, JsonObject | null>>;
	readonly conversation?: ConversationRecord;
};

/**
 * What one commit changed in a watched view, so a client keeps the view without chord: some parts, or the whole view,
 * as after a watch that fell behind.
 */
export type ViewChange = ViewParts | { readonly view: ConversationView };

/**
 * What `ops` changed in a watched view, as whole values of `view`, the view after them: the entries from the first one
 * that an op reached, each document that an op reached, and the conversation record. An op on the root, or on a part
 * that this does not know, gives the whole view.
 */
export function viewChange(view: ConversationView, ops: readonly Op[]): ViewChange {
	let from: number | undefined;
	const kinds = new Set<string>();
	let conversation = false;

	for (const op of ops) {
		if (op[0] === "r") return { view };
		const [part, next] = op[1];

		if (part === "entries") {
			const index = next !== undefined ? Number(next) : op[0] === "p" ? op[2] : 0;
			from = Math.min(from ?? index, index);
		} else if (part === "docs" && next !== undefined) {
			kinds.add(String(next));
		} else if (part === "conversation") {
			conversation = true;
		} else {
			return { view };
		}
	}

	const parts: { -readonly [Part in keyof ViewParts]: ViewParts[Part] } = {};

	if (from !== undefined) parts.entries = { from, items: view.entries.slice(from) };

	if (kinds.size > 0) {
		parts.docs = Object.fromEntries(
			[...kinds].map((kind): [string, JsonObject | null] => [kind, view.docs[kind] ?? null]),
		);
	}

	if (conversation) parts.conversation = view.conversation;

	return parts;
}

/** `view` after `change`. A client of a watch keeps its view up to date with it. */
export function applyChange(view: ConversationView, change: ViewChange): ConversationView {
	if ("view" in change) return change.view;
	const { entries, docs = {}, conversation } = change;
	const changedDocs = { ...view.docs };

	for (const [kind, doc] of Object.entries(docs)) {
		if (doc === null) delete changedDocs[kind];
		else changedDocs[kind] = doc;
	}

	return {
		conversation: conversation ?? view.conversation,
		entries: entries === undefined ? view.entries : [...view.entries.slice(0, entries.from), ...entries.items],
		docs: changedDocs,
	};
}
