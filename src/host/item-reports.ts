/**
 * The rule of the items on the reports of the workers: a commit that a worker of an item reports lands on the item and
 * closes it. The host gives this handler of the reports before the handler of an entry.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { refParts } from "../protocol/item.ts";
import type { ReportedHandler } from "./entries.ts";
import type { ItemIndex } from "./item-index.ts";
import { landCommits } from "./items.ts";
import { workState } from "./label-checks.ts";
import { stopWork, type WorkStopHost } from "./work-workers.ts";

const context = BACKGROUND_CONTEXT;

/** What the rule of the items on the reports uses of the host. */
export type ItemReportHost = WorkStopHost & {
	/** The index of the ends of the items, which gives the items that a contract shapes. */
	readonly items: Pick<ItemIndex, "itemsOf">;
};

/**
 * The handler of the reports that runs the rule of the items (`landCommits`) in one commit: for each label `item:<id>`
 * of the worker that names an item of the store, each commit reference of the report lands on the item, and an open
 * item becomes `done`. After the commit, the workers of each item that it set `done` and of each contract that it ended
 * stop, but the reporter. A repeat of the report adds no edge and changes no closed item.
 */
export function itemReports(host: ItemReportHost): ReportedHandler {
	return async ({ worker, labels, refs, caller }) => {
		const ids = await itemIds(host, labels);

		if (ids.length === 0) return;
		const landed = await host.harness.commit((tx) => landCommits(tx, ids, refs, caller, host.items), context);
		const ended = [...landed.done.map((id) => `item:${id}`), ...landed.ended.map((slug) => `parley:${slug}`)];
		await stopWork(host, ended, worker);
	};
}

/**
 * The IDs of the items of the store that the labels `item:<id>` of `labels` name. A label of no item gives none, so
 * the commit of the report does not create its item.
 */
async function itemIds(host: ItemReportHost, labels: readonly string[]): Promise<number[]> {
	const ids: number[] = [];

	for (const label of labels) {
		const { kind, value } = refParts(label);

		if (kind === "item" && (await workState(host.harness, label))?.state !== "unknown") ids.push(Number(value));
	}

	return ids;
}
