/**
 * The move of the items that the children of an old store served to their labels: the `agent:<conversation> serves`
 * edges of the items, which the records of the children of version 5 and 6 did not name. The document of the move
 * says that it ran, so a later start reads no item.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { EntryHandles } from "../host/entries.ts";
import type { Edge, WorkItem } from "../protocol/item.ts";
import { allItems, Items } from "./item-docs.ts";

const context = BACKGROUND_CONTEXT;

/** The prefix of the `from` end of the edge of a child that serves an item, before its conversation ID. */
const AGENT_PREFIX = "agent:";

/** The time of the move, which the commit of the move writes. */
export const LabelMove = durable.defineDoc<{ at: number }>({
	kind: "harness.label-move",
	version: 1,
	scope: "session",
	initial: () => ({ at: 0 }),
	checkpointWhen: () => true,
});

/**
 * Gives the child of each `agent:<conversation> serves item:<id>` edge the label `item:<id>`, with `labelChild`, and
 * then takes the edges from the items, in one commit that also writes the document of the move. An edge whose
 * conversation is no child of the host stays. It does nothing when the document of the move exists. `storage` lists the
 * items. A start after a failure before the commit adds each label once, and moves the edges again.
 */
export async function migrateLabels(
	harness: Harness,
	storage: Pick<Storage, "scanDocuments">,
	labelChild: EntryHandles["labelChild"],
): Promise<void> {
	if ((await harness.snapshot(LabelMove, context)) !== undefined) return;
	const moves: { item: WorkItem; labelled: Edge[] }[] = [];

	for (const item of await allItems(harness, storage, context)) {
		const labelled: Edge[] = [];

		for (const edge of item.edges.filter(isAgentEdge)) {
			if (await labelChild(edge.from.slice(AGENT_PREFIX.length), `item:${item.id}`)) labelled.push(edge);
		}

		if (labelled.length > 0) moves.push({ item, labelled });
	}

	await harness.commit(async (tx) => {
		for (const { item, labelled } of moves) {
			const draft = await tx.doc(Items, String(item.id), Value.Clone(item));
			draft.edges = draft.edges.filter((edge) => !labelled.some((done) => Value.Equal(done, edge)));
		}

		(await tx.doc(LabelMove)).at = Date.now();
	}, context);
}

/** Whether `edge` is the `serves` edge of a child. */
function isAgentEdge(edge: Edge): boolean {
	return edge.from.startsWith(AGENT_PREFIX) && edge.kind === "serves";
}
