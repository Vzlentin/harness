/**
 * The stops of the workers of the work of the project: the workers of a parley or an item that ended, but the worker
 * whose report ended it.
 */
import type { Harness } from "@earendil-works/pi-durable";
import type { EntryHandles } from "../host/entries.ts";
import type { WorkerId, Worker } from "../protocol/worker-labels.ts";
import { workState } from "./work-state.ts";

/** What the stops of the workers use of the host. */
export type WorkStopHost = Pick<EntryHandles, "liveWorkers" | "stop" | "warn"> & {
	readonly harness: Pick<Harness, "snapshot">;
};

/** Stops the live workers of each label of `labels`, but `except` when it gives one. A failed stop is a warning. */
export async function stopWork(host: WorkStopHost, labels: readonly string[], except?: WorkerId): Promise<void> {
	if (labels.length === 0) return;

	try {
		const live = await host.liveWorkers();

		for (const worker of new Set(labels.flatMap((label) => live.get(label) ?? []))) {
			if (except === undefined || !sameWorker(worker, except)) await host.stop(worker).catch(host.warn);
		}
	} catch (cause) {
		host.warn(cause);
	}
}

/**
 * Stops the live workers of each label of the work of the project that ended, a parley or an item that is done or
 * dropped, such as the workers that a message resumed after the end of their work. The entry runs it once at its open.
 * A worker of work that the store does not have is left as it is.
 */
export async function stopEndedWork(host: WorkStopHost): Promise<void> {
	try {
		const ended: string[] = [];

		for (const label of (await host.liveWorkers()).keys()) {
			if ((await workState(host.harness, label))?.state === "ended") ended.push(label);
		}

		await stopWork(host, ended);
	} catch (cause) {
		host.warn(cause);
	}
}

/** Whether `worker` is `other`: the same kind, and the same handle or key. */
function sameWorker(worker: Worker, other: WorkerId): boolean {
	if (worker.kind === "agent") return other.kind === "agent" && other.handle === worker.handle;

	return other.kind === "task" && other.key === worker.key;
}
