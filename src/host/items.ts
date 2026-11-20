/**
 * The work items of the store of the project: one document of the session for each item, keyed by its ID, which each
 * write stores whole, and the counter of their IDs. The `item` request of the host reads them and changes them with
 * these functions, each change in its own commit.
 */
import type { Context } from "@earendil-works/chord/context";
import type { DocumentReader, Storage, Tx } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import {
	type Edge,
	type EdgeInput,
	type EdgeKind,
	ITEM_KIND,
	type ItemAdd,
	ITEM_COUNTER_KIND,
	type ItemCounter,
	type ItemList,
	type ItemSet,
	type ItemState,
	type WorkItem,
} from "../protocol/item.ts";
import { familyKeys } from "./doc-family.ts";
import { knownParley, Parleys } from "./project-docs.ts";
import { library } from "./targets.ts";

/** The items, one document for each, keyed by its ID. An item is small, so each write stores a whole base. */
const Items = durable.defineDocFamily<WorkItem, WorkItem>({
	kind: ITEM_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

/** The counter of the IDs of items. */
const ItemCounterDoc = durable.defineDoc<ItemCounter>({
	kind: ITEM_COUNTER_KIND,
	version: 1,
	scope: "session",
	initial: () => ({ last: 0 }),
	checkpointWhen: () => true,
});

/** Adds an open item with no edge for the caller `by`, with the ID after `last` of the counter, and gives it. */
export async function addItem(tx: Tx, input: ItemAdd, by: string): Promise<WorkItem> {
	const counter = await tx.doc(ItemCounterDoc);
	counter.last += 1;
	const item: WorkItem = { id: counter.last, title: input.title, state: "open", edges: [], at: Date.now(), by };

	if (input.text !== undefined) item.text = input.text;
	// The new document starts as a copy of the seed.
	await tx.doc(Items, String(item.id), item);

	return item;
}

/** Changes the fields that `change` gives of the item `change.id` for the caller `by`, and gives the item. */
export async function setItem(tx: Tx, change: ItemSet, by: string): Promise<WorkItem> {
	const item = await itemDraft(tx, change.id);

	if (change.title !== undefined) item.title = change.title;

	if (change.text !== undefined) item.text = change.text;

	if (change.state !== undefined) item.state = change.state;
	item.at = Date.now();
	item.by = by;

	return Value.Clone(item);
}

/**
 * Checks the edge `input` and writes it into the document of its item for the caller `by`, and gives it. The kind fixes
 * the ends, the item must exist, and an edge with the same ends and kind is not written again: its stored edge is the
 * reply. A `serves` or `shapes` edge needs an open item, and an agent or a parley at its other end. A run or a commit
 * end is checked for its form only.
 */
export async function linkItem(tx: Tx, input: EdgeInput, by: string): Promise<Edge> {
	const { id, other } = endsOf(input);
	const item = await itemDraft(tx, id);
	const stored = item.edges.find((edge) => sameEdge(edge, input));

	if (stored !== undefined) return Value.Clone(stored);

	if (input.kind !== "landed" && item.state !== "open") {
		throw new Error(`Item ${id} is ${item.state}: an edge ${input.kind} cannot go to it`);
	}

	await knownEnd(tx, other);
	const edge: Edge = { from: input.from, kind: input.kind, to: input.to, at: Date.now(), by };
	item.edges.push({ ...edge });

	return edge;
}

/** Removes the edge `input` from the document of its item, and gives the item. The item keeps its `at` and `by`. */
export async function unlinkItem(tx: Tx, input: EdgeInput): Promise<WorkItem> {
	const { id } = endsOf(input);
	const item = await itemDraft(tx, id);
	const index = item.edges.findIndex((edge) => sameEdge(edge, input));

	if (index === -1) throw new Error(`Item ${id} has no edge ${input.from} ${input.kind} ${input.to}`);
	item.edges.splice(index, 1);

	return Value.Clone(item);
}

/** The item `id`, in any state, with its edges. */
export async function readItem(
	reader: Pick<DocumentReader, "snapshot">,
	id: number,
	context: Context,
): Promise<WorkItem> {
	const item = await reader.snapshot(Items, String(id), context);

	if (item === undefined) throw new Error(`Unknown item: ${id}`);

	return Value.Clone(item);
}

/**
 * The items in the state `state`, in ID order. `storage`, the storage of `reader`, lists the items, because the session
 * gives no list of the members of a family.
 */
export async function readItems(
	reader: Pick<DocumentReader, "snapshot">,
	storage: Pick<Storage, "scanDocuments">,
	state: ItemState,
	context: Context,
): Promise<ItemList> {
	const keys = await familyKeys(storage, Items, context);
	const items = await Promise.all(keys.map((key) => reader.snapshot(Items, key, context)));

	return {
		items: items.flatMap((item) => (item?.state === state ? [Value.Clone(item)] : [])).sort((a, b) => a.id - b.id),
	};
}

/**
 * The draft of the item `id` in `tx`. An ID above `last` of the counter fails with `Unknown item: <id>`, also while no
 * item exists, so only `addItem` creates the counter.
 */
async function itemDraft(tx: Tx, id: number): Promise<WorkItem> {
	const { last } = await tx.doc(ItemCounterDoc);

	if (id > last) throw new Error(`Unknown item: ${id}`);
	// `addItem` creates the document of each ID up to `last`, so `tx.doc` loads it and never stores this seed.
	const seed: WorkItem = { id, title: "-", state: "open", edges: [], at: 0, by: "" };

	return tx.doc(Items, String(id), seed);
}

/** The kinds of references that the ends of an edge take: one of `from`, and `to`. */
type EdgeEnds = { readonly from: readonly string[]; readonly to: string };

/** A reference `<kind>:<value>`, cut at its first colon. */
type RefParts = { readonly kind: string; readonly value: string };

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

/**
 * The ID of the item at one end of `edge`, and the reference at its other end. `serves` goes from an agent or a run to
 * an item, `shapes` from a parley to an item, and `landed` from an item to a commit: other ends fail.
 */
function endsOf(edge: EdgeInput): { readonly id: number; readonly other: string } {
	const ends = edgeEnds(edge.kind);
	const from = refParts(edge.from);
	const to = refParts(edge.to);

	if (!ends.from.includes(from.kind) || to.kind !== ends.to) {
		throw new Error(`An edge ${edge.kind} cannot go from ${edge.from} to ${edge.to}`);
	}

	return ends.to === "item" ? { id: Number(to.value), other: edge.from } : { id: Number(from.value), other: edge.to };
}

/**
 * Fails when `ref`, the end of an edge that is not its item, is an agent or a parley that the store does not have. An
 * agent is a conversation that the children library opened. A run or a commit is not checked.
 */
async function knownEnd(tx: Tx, ref: string): Promise<void> {
	const { kind, value } = refParts(ref);

	if (kind === "agent" && (await library.opened(tx, value)) === undefined) {
		throw new Error(`Unknown conversation: ${value}`);
	}

	if (kind === "parley") knownParley((await tx.doc(Parleys)).parleys, value);
}

/** The kind and the value of the reference `ref`, `<kind>:<value>`. */
function refParts(ref: string): RefParts {
	const colon = ref.indexOf(":");

	return { kind: ref.slice(0, colon), value: ref.slice(colon + 1) };
}

/** Whether `edge` has the ends and the kind of `input`. */
function sameEdge(edge: Edge, input: EdgeInput): boolean {
	return edge.from === input.from && edge.kind === input.kind && edge.to === input.to;
}
