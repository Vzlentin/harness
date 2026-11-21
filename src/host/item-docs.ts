/**
 * The documents of the work items: one document of the session for each item, keyed by its ID, and the counter of
 * their IDs. It reads the items, the `needs` edges that go to an item, and the other ends of the edges of an item.
 */
import type { Context } from "@earendil-works/chord/context";
import type { CommitChange, DocumentReader, Storage } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import {
	ITEM_COUNTER_KIND,
	ITEM_KIND,
	type ItemCounter,
	type ItemState,
	refParts,
	type WorkItem,
} from "../protocol/item.ts";
import { familyKeys } from "./doc-family.ts";

/** The items, one document for each, keyed by its ID. An item is small, so each write stores a whole base. */
export const Items = durable.defineDocFamily<WorkItem, WorkItem>({
	kind: ITEM_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

/** The ID of the item whose document `change` changes or retires, and nothing for another change. */
export function changedItemId(change: CommitChange): number | undefined {
	if (change.type !== "document" || change.record.kind !== ITEM_KIND || change.record.key === undefined)
		return undefined;

	return Number(change.record.key);
}

/** Whether `change` changes or retires the document of an item or the counter of their IDs. */
export function itemChange(change: CommitChange): boolean {
	return change.type === "document" && (change.record.kind === ITEM_KIND || change.record.kind === ITEM_COUNTER_KIND);
}

/** The counter of the IDs of items. */
export const ItemCounterDoc = durable.defineDoc<ItemCounter>({
	kind: ITEM_COUNTER_KIND,
	version: 1,
	scope: "session",
	initial: () => ({ last: 0 }),
	checkpointWhen: () => true,
});

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
 * The item `id`, in any state, with its edges and then the `needs` edges that go to it from other items, in the ID order
 * of those items. Only the item that needs another stores the edge.
 */
export async function readItemBothWays(
	reader: Pick<DocumentReader, "snapshot">,
	storage: Pick<Storage, "scanDocuments">,
	id: number,
	context: Context,
): Promise<WorkItem> {
	const item = await readItem(reader, id, context);
	const to = `item:${id}`;

	for (const other of await allItems(reader, storage, context)) {
		for (const edge of other.edges) if (edge.kind === "needs" && edge.to === to) item.edges.push(Value.Clone(edge));
	}

	return item;
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
): Promise<WorkItem[]> {
	const items = await allItems(reader, storage, context);

	return items.flatMap((item) => (item.state === state ? [Value.Clone(item)] : []));
}

/** The other ends of the `serves` and `shapes` edges of an item, without their kinds, in the order of the edges. */
export type ItemEnds = {
	/** The IDs of the runs that serve the item. */
	readonly runs: readonly string[];
	/** The slugs of the parleys that shape the item. */
	readonly parleys: readonly string[];
};

/** The other ends of the `serves` and `shapes` edges of `item`. */
export function itemEnds(item: Readonly<WorkItem>): ItemEnds {
	const runs: string[] = [];
	const parleys: string[] = [];

	for (const edge of item.edges) {
		const { kind, value } = refParts(edge.from);

		if (kind === "run") runs.push(value);
		else if (kind === "parley") parleys.push(value);
	}

	return { runs, parleys };
}

/** Every item, in ID order, as the session has it. `storage`, the storage of `reader`, lists them. */
export async function allItems(
	reader: Pick<DocumentReader, "snapshot">,
	storage: Pick<Storage, "scanDocuments">,
	context: Context,
): Promise<Readonly<WorkItem>[]> {
	const keys = await familyKeys(storage, Items, context);
	const items = await Promise.all(keys.map((key) => reader.snapshot(Items, key, context)));

	return items.filter((item) => item !== undefined).sort((a, b) => a.id - b.id);
}
