/**
 * The work items of the store of the project: the references, the edges, the items and the counter of their IDs, the
 * stages of an item and the item as a reply gives it, the ends of an edge and the parts of a reference, the inputs of the `item` request, the text of an item and of an
 * edge, and the kinds of their documents.
 */
import { type Static, Type } from "typebox";
import { SLUG } from "./paths.ts";
import { Caller, LocalId, Text, Time } from "./project.ts";

/** A reference: the kind and the ID that the kind already has. No new ID scheme. */
export const Ref = Type.Union([
	Type.String({ pattern: "^item:[1-9][0-9]*$" }),
	/** The ID of the conversation of a child. */
	Type.String({ pattern: "^agent:[1-9][0-9]*$" }),
	/** A run ID of workflows, as `newRunId()` makes it. */
	Type.String({ pattern: "^run:[0-9]{8}T[0-9]{6}-[0-9a-f]{8}$" }),
	Type.String({ pattern: `^parley:${SLUG.source.slice(1, -1)}$` }),
	Type.String({ pattern: "^commit:[0-9a-f]{40}$" }),
]);

export type Ref = Static<typeof Ref>;

/** The kinds of an edge. */
export const EDGE_KINDS = ["serves", "shapes", "landed"] as const;

export const EdgeKind = Type.Enum(EDGE_KINDS);

export type EdgeKind = Static<typeof EdgeKind>;

/** A link between two things, one of them an item. It is a fact: it never changes after its write. */
export const Edge = Type.Object({ from: Ref, kind: EdgeKind, to: Ref, at: Time, by: Caller });

export type Edge = Static<typeof Edge>;

/** The states of an item: `open` is work to do, `done` ended as intended, and `dropped` was given up. */
export const ITEM_STATES = ["open", "done", "dropped"] as const;

export const ItemState = Type.Enum(ITEM_STATES);

export type ItemState = Static<typeof ItemState>;

/**
 * A piece of work of the project. `title` is one line, `text` says in Markdown what to build when no contract says it,
 * and `edges` are in the order of their writes. `at` is the time of the last change, and `by` the caller of that
 * change.
 */
export const WorkItem = Type.Object({
	id: LocalId,
	title: Text,
	text: Type.Optional(Type.String()),
	state: ItemState,
	edges: Type.Array(Edge),
	at: Time,
	by: Caller,
});

export type WorkItem = Static<typeof WorkItem>;

/**
 * The stages of an item, the columns of the board: `inbox` waits for work, `shaping` has an open parley, `ready` has a
 * contract, `building` has a live agent or run, and `done` and `dropped` are its states. The host works the stage out
 * at each read, and never stores it.
 */
export const ITEM_STAGES = ["inbox", "shaping", "ready", "building", "done", "dropped"] as const;

export const ItemStage = Type.Enum(ITEM_STAGES);

export type ItemStage = Static<typeof ItemStage>;

/**
 * An item as a reply gives it: the stored item, its stage, and `needsYou`, true when one of its parleys, agents or runs
 * waits for the user.
 */
export const StagedItem = Type.Object({ ...WorkItem.properties, stage: ItemStage, needsYou: Type.Boolean() });

export type StagedItem = Static<typeof StagedItem>;

/** The counter of the IDs of items. `last` only grows. */
export const ItemCounter = Type.Object({ last: Type.Integer({ minimum: 0 }) });

export type ItemCounter = Static<typeof ItemCounter>;

/** The input of a new item. */
export const ItemAdd = Type.Object({ title: Text, text: Type.Optional(Type.String()) });

export type ItemAdd = Static<typeof ItemAdd>;

/** The input of a change of the item `id`: the fields that change. */
export const ItemSet = Type.Object({
	id: LocalId,
	title: Type.Optional(Text),
	text: Type.Optional(Type.String()),
	state: Type.Optional(ItemState),
});

export type ItemSet = Static<typeof ItemSet>;

/** The input of a link or an unlink: the two ends of the edge and its kind. */
export const EdgeInput = Type.Object({ from: Ref, kind: EdgeKind, to: Ref });

export type EdgeInput = Static<typeof EdgeInput>;

/** Items with their stages, in ID order. */
export const ItemList = Type.Object({ items: Type.Array(StagedItem) });

export type ItemList = Static<typeof ItemList>;

/** The mark of an item that needs the user. */
export const NEEDS_YOU_MARK = "?";

/** The mark of each state of an item, when the item does not need the user. */
export const ITEM_MARKS = { open: "○", done: "✓", dropped: "✗" } as const satisfies Record<ItemState, string>;

/** The line of `item`: `<mark> <id> <stage> <title>`, where the mark is `NEEDS_YOU_MARK` when the item needs you. */
export function itemLine(item: StagedItem): string {
	const mark = item.needsYou ? NEEDS_YOU_MARK : ITEM_MARKS[item.state];

	return `${mark} ${item.id} ${item.stage} ${item.title}`;
}

/** The line of `edge`: `<from> <kind> <to>`. */
export function edgeLine(edge: EdgeInput): string {
	return `${edge.from} ${edge.kind} ${edge.to}`;
}

/** The text of a shown item: its line, its text when it has one, then the line of each edge, in the order of writes. */
export function itemText(item: StagedItem): string {
	const text = item.text === undefined || item.text === "" ? "" : `${item.text}\n`;

	return `${itemLine(item)}\n${text}${item.edges.map((edge) => `${edgeLine(edge)}\n`).join("")}`;
}

/** The kinds of references that the ends of an edge take: one of `from`, and `to`. */
type EdgeEnds = { readonly from: readonly string[]; readonly to: string };

/** The kinds of references that the ends of an edge of `kind` take. */
function edgeEnds(kind: EdgeKind): EdgeEnds {
	switch (kind) {
		case "serves":
			return { from: ["agent", "run"], to: "item" };
		case "shapes":
			return { from: ["parley"], to: "item" };
		case "landed":
			return { from: ["item"], to: "commit" };
	}
}

/** The item end of an edge, by its ID, and the reference at its other end. */
export type EdgeItem = { readonly id: number; readonly other: string };

/**
 * The ID of the item at one end of `edge`, and the reference at its other end. `serves` goes from an agent or a run to
 * an item, `shapes` from a parley to an item, and `landed` from an item to a commit: other ends give nothing.
 */
export function edgeItem(edge: EdgeInput): EdgeItem | undefined {
	const ends = edgeEnds(edge.kind);
	const from = refParts(edge.from);
	const to = refParts(edge.to);

	if (!ends.from.includes(from.kind) || to.kind !== ends.to) return undefined;

	return ends.to === "item" ? { id: Number(to.value), other: edge.from } : { id: Number(from.value), other: edge.to };
}

/** A reference `<kind>:<value>`, cut at its first colon. */
export type RefParts = { readonly kind: string; readonly value: string };

/** The kind and the value of the reference `ref`, `<kind>:<value>`. */
export function refParts(ref: string): RefParts {
	const colon = ref.indexOf(":");

	return { kind: ref.slice(0, colon), value: ref.slice(colon + 1) };
}

/** The kind of the family of the documents of the items, one for each item, keyed by its ID. */
export const ITEM_KIND = "harness.item";

/** The kind of the document of the counter of the IDs of items. */
export const ITEM_COUNTER_KIND = "harness.items";
