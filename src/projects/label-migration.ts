/**
 * The move of the items that the children of an old store served to their labels: the `agent:<conversation> serves`
 * edges of the items, which the records of the children of version 5 and 6 did not name.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { EntryHandles } from "../host/entries.ts";
import type { Edge } from "../protocol/item.ts";
import { allItems, Items } from "./item-docs.ts";

const context = BACKGROUND_CONTEXT;

/** The prefix of the `from` end of the edge of a child that serves an item, before its conversation ID. */
const AGENT_PREFIX = "agent:";

/**
 * Gives the child of each `agent:<conversation> serves item:<id>` edge the label `item:<id>`, with `labelChild`, and
 * then takes the edge from the item. An edge whose conversation is no child of the host stays. It does nothing when no
 * item has such an edge. `storage` lists the items. A start after a failure between the two writes adds the label once.
 */
export async function migrateLabels(
	harness: Harness,
	storage: Pick<Storage, "scanDocuments">,
	labelChild: EntryHandles["labelChild"],
): Promise<void> {
	for (const item of await allItems(harness, storage, context)) {
		const labelled: Edge[] = [];

		for (const edge of item.edges.filter(isAgentEdge)) {
			if (await labelChild(edge.from.slice(AGENT_PREFIX.length), `item:${item.id}`)) labelled.push(edge);
		}

		if (labelled.length === 0) continue;

		await harness.commit(async (tx) => {
			const draft = await tx.doc(Items, String(item.id), Value.Clone(item));
			draft.edges = draft.edges.filter((edge) => !labelled.some((done) => Value.Equal(done, edge)));
		}, context);
	}
}

/** Whether `edge` is the `serves` edge of a child. */
function isAgentEdge(edge: Edge): boolean {
	return edge.from.startsWith(AGENT_PREFIX) && edge.kind === "serves";
}
