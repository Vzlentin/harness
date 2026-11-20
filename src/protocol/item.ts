/**
 * The work items of the store of the project: the references, the edges, the items and the counter of their IDs, the
 * inputs of the `item` request, and the kinds of their documents.
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

/** Items, in ID order. */
export const ItemList = Type.Object({ items: Type.Array(WorkItem) });

export type ItemList = Static<typeof ItemList>;

/** The kind of the family of the documents of the items, one for each item, keyed by its ID. */
export const ITEM_KIND = "harness.item";

/** The kind of the document of the counter of the IDs of items. */
export const ITEM_COUNTER_KIND = "harness.items";
