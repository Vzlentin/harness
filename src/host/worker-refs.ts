/**
 * The result references of the workers, which `report` stores: by handle for the children of the host, and by `start`
 * key for the started tasks.
 */
import * as durable from "@earendil-works/pi-durable";
import { boundedReplay } from "../protocol/checkpoint.ts";
import type { WorkerId } from "../protocol/worker-labels.ts";

/** The references of each worker, each once, in the order of their first report. */
export type WorkerRefLists = { agents: Record<string, string[]>; tasks: Record<string, string[]> };

/** The result references of the workers. A worker has an entry once it reported; the host never removes one. */
export const WorkerRefs = durable.defineDoc<WorkerRefLists>({
	kind: "harness.worker-refs",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ agents: {}, tasks: {} }),
});

/** The references of `worker` in `state` for its info and its node: none when it has no reference. */
export function workerRefs(
	state: Readonly<WorkerRefLists> | undefined,
	worker: WorkerId,
): { readonly refs?: string[] } {
	const refs = refsOf(state, worker);

	return refs.length === 0 ? {} : { refs: [...refs] };
}

/** Adds each reference of `refs` that `worker` does not have to its list in `state`, and gives the list. */
export function addRefs(state: WorkerRefLists, worker: WorkerId, refs: readonly string[]): readonly string[] {
	const list = [...refsOf(state, worker)];

	for (const ref of refs) if (!list.includes(ref)) list.push(ref);

	if (worker.kind === "agent") state.agents[worker.handle] = list;
	else state.tasks[worker.key] = list;

	return list;
}

/** The references of `worker` in `state`, none for a worker that did not report. */
function refsOf(state: Readonly<WorkerRefLists> | undefined, worker: WorkerId): readonly string[] {
	if (state === undefined) return [];

	const [lists, name] = worker.kind === "agent" ? [state.agents, worker.handle] : [state.tasks, worker.key];

	return Object.hasOwn(lists, name) ? (lists[name] ?? []) : [];
}
