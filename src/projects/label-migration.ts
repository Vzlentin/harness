/**
 * The move of the items that the children of an old store served to their labels: the `agent:<conversation> serves`
 * edges of the items, which the records of the children of version 5 and 6 did not name. The document of the move
 * says that it ran, so a later start reads no item.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import type { EntryHandles } from "../host/entries.ts";
import type { Edge } from "../protocol/item.ts";
import type { ProjectStore } from "./project-store.ts";

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
 * then takes the edges from the items of `store`, in one write of the project store in the commit that writes the
 * document of the move. An edge whose conversation is no child of the host stays. It does nothing when the document of
 * the move exists. A start after a failure before the commit adds each label once, and moves the edges again.
 */
export async function migrateLabels(
	harness: Harness,
	store: Pick<ProjectStore, "items" | "write">,
	labelChild: EntryHandles["labelChild"],
): Promise<void> {
	if ((await harness.snapshot(LabelMove, context)) !== undefined) return;
	const labelled: Edge[] = [];

	for (const item of store.items()) {
		for (const edge of item.edges.filter(isAgentEdge)) {
			if (await labelChild(edge.from.slice(AGENT_PREFIX.length), `item:${item.id}`)) labelled.push(edge);
		}
	}

	await harness.commit(async (tx) => {
		(await tx.doc(LabelMove)).at = Date.now();
		store.write((stx) => {
			for (const edge of labelled) stx.removeEdge(edge);
		});
	}, context);
}

/** Whether `edge` is the `serves` edge of a child. */
function isAgentEdge(edge: Edge): boolean {
	return edge.from.startsWith(AGENT_PREFIX) && edge.kind === "serves";
}
