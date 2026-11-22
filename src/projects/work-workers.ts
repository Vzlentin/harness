/**
 * The stops of the workers of the work of the project: the workers of a parley or an item that ended, but the worker
 * whose report ended it. The agent that ended the work stops after its turn. Each held action of an agent that a stop
 * ends is dropped.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { EntryHandles } from "../host/entries.ts";
import type { WorkerId, Worker } from "../protocol/worker-labels.ts";
import { dropHeldOf } from "./project.ts";
import { workState } from "./work-state.ts";

const context = BACKGROUND_CONTEXT;

/** What the stops of the workers use of the host. */
export type WorkStopHost = Pick<EntryHandles, "liveWorkers" | "stop" | "stopAfterTurn" | "warn"> & {
	readonly harness: Pick<Harness, "snapshot" | "commit">;
};

/**
 * Which workers a stop of the work leaves running: `spare`, the worker that is not stopped, and `caller`, the
 * conversation of the agent worker that stops after its turn.
 */
export type WorkStopOptions = { readonly spare?: WorkerId; readonly caller?: string };

/**
 * Stops the live workers of each label of `labels`, but `spare`, and awaits them. The agent worker whose conversation is
 * `caller` stops after its turn, and the stop does not await it. After the stop of an agent, its held actions are
 * dropped. A failed stop or drop is a warning.
 */
export async function stopWork(
	host: WorkStopHost,
	labels: readonly string[],
	options: WorkStopOptions = {},
): Promise<void> {
	if (labels.length === 0) return;

	try {
		const live = await host.liveWorkers();

		for (const worker of new Set(labels.flatMap((label) => live.get(label) ?? []))) {
			if (options.spare !== undefined && sameWorker(worker, options.spare)) continue;

			const later = worker.kind === "agent" && worker.conversation === options.caller;

			const stopped = (worker.kind === "agent" && later ? host.stopAfterTurn(worker) : host.stop(worker))
				.then(() => (worker.kind === "agent" ? dropHeldActions(host, worker.conversation) : undefined))
				.catch(host.warn);

			if (!later) await stopped;
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

/** Drops the held actions of the stopped agent `agent`, for the caller `agent`. */
async function dropHeldActions(host: WorkStopHost, agent: string): Promise<void> {
	await host.harness.commit((tx) => dropHeldOf(tx, agent), context);
}

/** Whether `worker` is `other`: the same kind, and the same handle or key. */
function sameWorker(worker: Worker, other: WorkerId): boolean {
	if (worker.kind === "agent") return other.kind === "agent" && other.handle === worker.handle;

	return other.kind === "task" && other.key === worker.key;
}
