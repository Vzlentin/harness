/**
 * The rule of the items on the reports of the workers: a commit that a worker of an item reports lands on the item and
 * closes it. The projects entry gives it as its handler of the reports.
 */
import type { ReportedHandler } from "../host/entries.ts";
import { refParts } from "../protocol/item.ts";
import { landCommits } from "./items.ts";
import type { ProjectStore } from "./project-store.ts";
import { workState } from "./work-state.ts";
import { stopWork, type WorkStopHost } from "./work-workers.ts";

/** What the rule of the items on the reports uses of the host. */
export type ItemReportHost = WorkStopHost & {
	/** The project store, with the items, their edges and the parleys. */
	readonly store: Pick<ProjectStore, "findParleyBySlug" | "findItem" | "write">;
};

/**
 * The handler of the reports that runs the rule of the items (`landCommits`) in one write of the project store: for each label `item:<id>`
 * of the worker that names an item of the store, each commit reference of the report lands on the item, and an open
 * item becomes `done`. After the write, the workers of each item that it set `done` and of each contract that it ended
 * stop, but the reporter. A repeat of the report adds no edge and changes no closed item.
 */
export function itemReports(host: ItemReportHost): ReportedHandler {
	return async ({ worker, labels, refs, caller }) => {
		const ids = itemIds(host, labels);

		if (ids.length === 0) return;
		const landed = host.store.write((tx) => landCommits(tx, ids, refs, caller));
		const ended = [...landed.done.map((id) => `item:${id}`), ...landed.ended.map((slug) => `parley:${slug}`)];
		await stopWork(host, ended, { match: worker, stop: "spare" });
	};
}

/**
 * The IDs of the items of the store that the labels `item:<id>` of `labels` name. A label of no item gives none, so
 * the write of the report does not fail.
 */
function itemIds(host: ItemReportHost, labels: readonly string[]): number[] {
	const ids: number[] = [];

	for (const label of labels) {
		const { kind, value } = refParts(label);

		if (kind === "item" && workState(host.store, label)?.state !== "unknown") ids.push(Number(value));
	}

	return ids;
}
