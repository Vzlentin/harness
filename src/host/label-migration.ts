/**
 * The move of what each child served to its labels, at the first start of a host whose records of the children still
 * have `serves`: the records of version 5 and 6, and the `agent:` serves edges of the items, in one commit.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { allItems, Items } from "./item-docs.ts";
import { type ChildRecord, ChildRecords } from "./records.ts";

const context = BACKGROUND_CONTEXT;

/**
 * What a record of version 5 or 6 served: its spawner, an open parley or a contract by slug, or the item whose
 * `agent:<conversation> serves` edge names the child.
 */
const OldServes = Type.Union([
	Type.Object({ kind: Type.Literal("spawner") }),
	Type.Object({ kind: Type.Literal("parley"), slug: Type.String() }),
	Type.Object({ kind: Type.Literal("contract"), slug: Type.String() }),
	Type.Object({ kind: Type.Literal("item") }),
]);

/** A record of version 5 or 6, with what it served. */
const OldRecord = Type.Object({ serves: OldServes });

/** A record of version 5 that served a todo of the list of the project, before the move of the todos to items. */
export const OldTodoRecord = Type.Object({ serves: Type.Object({ kind: Type.Literal("todo"), id: Type.Integer() }) });

/**
 * Turns `serves` of each record into its labels, once: a spawner gives none, a parley or a contract gives
 * `parley:<slug>`, and an item gives `item:<id>` from the `agent:<conversation> serves item:<id>` edge, which leaves
 * the item. A record with no edge gets no label. It does nothing when no record has `serves`. `storage` lists the items.
 * The lock of the host keeps other writers out between the read and the commit.
 */
export async function migrateLabels(harness: Harness, storage: Pick<Storage, "scanDocuments">): Promise<void> {
	const state = await harness.snapshot(ChildRecords, context);

	if (!Object.values(state?.children ?? {}).some((record) => Value.Check(OldRecord, record))) return;
	const items = await allItems(harness, storage, context);

	await harness.commit(async (tx) => {
		for (const record of Object.values((await tx.doc(ChildRecords)).children)) {
			if (!Value.Check(OldRecord, record)) continue;
			const { serves } = record;
			let labels: string[] = [];

			if (serves.kind === "parley" || serves.kind === "contract") labels = [`parley:${serves.slug}`];

			if (serves.kind === "item") {
				const agent = `agent:${record.conversationId}`;
				const served = items.find((item) => item.edges.some((edge) => isAgentEdge(edge, agent)));

				if (served !== undefined) {
					const item = await tx.doc(Items, String(served.id), Value.Clone(served));
					item.edges = item.edges.filter((edge) => !isAgentEdge(edge, agent));
					labels = [`item:${served.id}`];
				}
			}

			relabel(record, labels);
		}
	}, context);
}

/**
 * Gives `record` the labels `labels` in place of what it served before, and drops the end of what it served, which
 * the records of version 5 and 6 kept.
 */
export function relabel(record: ChildRecord, labels: string[]): void {
	Reflect.deleteProperty(record, "serves");
	Reflect.deleteProperty(record, "servedEnd");
	record.labels = labels;
}

/** Whether `edge` is the `serves` edge from `agent`. */
function isAgentEdge(edge: { readonly from: string; readonly kind: string }, agent: string): boolean {
	return edge.from === agent && edge.kind === "serves";
}
