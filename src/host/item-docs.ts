/**
 * The documents of the work items: one document of the session for each item, keyed by its ID, and the counter of
 * their IDs. It reads the items, the other ends of the edges of an item, and the item that a child serves, which the
 * `serves` edge of the item names.
 */
import type { Context } from "@earendil-works/chord/context";
import type { DocumentReader, Storage } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { ITEM_COUNTER_KIND, ITEM_KIND, type ItemCounter, type ItemState, type WorkItem } from "../protocol/item.ts";
import { familyKeys } from "./doc-family.ts";
import type { ChildRecord } from "./records.ts";

/** The items, one document for each, keyed by its ID. An item is small, so each write stores a whole base. */
export const Items = durable.defineDocFamily<WorkItem, WorkItem>({
	kind: ITEM_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

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

/**
 * The item that the child of a record serves: the item whose `serves` edge names the child, and the item with the
 * lowest ID when several do. It gives nothing for a record that does not serve an item, and for a child that no edge
 * names.
 */
export type ChildItem = (record: Readonly<ChildRecord>) => Readonly<WorkItem> | undefined;

/**
 * The item that the child of each record of `records` serves. When no record of `records` serves an item, there is
 * nothing to look up, and it reads no item.
 */
export async function childItems(
	reader: Pick<DocumentReader, "snapshot">,
	storage: Pick<Storage, "scanDocuments">,
	records: readonly Readonly<ChildRecord>[],
	context: Context,
): Promise<ChildItem> {
	if (!records.some((record) => record.serves.kind === "item")) return () => undefined;
	const served = new Map<string, Readonly<WorkItem>>();

	for (const item of await allItems(reader, storage, context)) {
		for (const agent of itemEnds(item).agents) {
			if (!served.has(agent)) served.set(agent, item);
		}
	}

	return (record) => (record.serves.kind === "item" ? served.get(String(record.conversationId)) : undefined);
}

/** The other ends of the `serves` and `shapes` edges of an item, without their kinds, in the order of the edges. */
export type ItemEnds = {
	/** The IDs of the conversations of the agents that serve the item. */
	readonly agents: readonly string[];
	/** The IDs of the runs that serve the item. */
	readonly runs: readonly string[];
	/** The slugs of the parleys that shape the item. */
	readonly parleys: readonly string[];
};

/** The other ends of the `serves` and `shapes` edges of `item`. */
export function itemEnds(item: Readonly<WorkItem>): ItemEnds {
	const agents: string[] = [];
	const runs: string[] = [];
	const parleys: string[] = [];

	for (const edge of item.edges) {
		const { kind, value } = refParts(edge.from);

		if (kind === "agent") agents.push(value);
		else if (kind === "run") runs.push(value);
		else if (kind === "parley") parleys.push(value);
	}

	return { agents, runs, parleys };
}

/** A reference `<kind>:<value>`, cut at its first colon. */
type RefParts = { readonly kind: string; readonly value: string };

/** The kind and the value of the reference `ref`, `<kind>:<value>`. */
export function refParts(ref: string): RefParts {
	const colon = ref.indexOf(":");

	return { kind: ref.slice(0, colon), value: ref.slice(colon + 1) };
}

/** Every item, in ID order, as the session has it. `storage`, the storage of `reader`, lists them. */
async function allItems(
	reader: Pick<DocumentReader, "snapshot">,
	storage: Pick<Storage, "scanDocuments">,
	context: Context,
): Promise<Readonly<WorkItem>[]> {
	const keys = await familyKeys(storage, Items, context);
	const items = await Promise.all(keys.map((key) => reader.snapshot(Items, key, context)));

	return items.filter((item) => item !== undefined).sort((a, b) => a.id - b.id);
}
