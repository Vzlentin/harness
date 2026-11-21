/**
 * The stops of the workers of the work of the project: the workers of a parley or an item that ended.
 */
import { workState } from "./label-checks.ts";
import { liveWorkers, stopWorker, type WorkerHost } from "./workers.ts";

/** What the stops of the workers use of the host. */
export type WorkStopHost = WorkerHost & { readonly warn: (cause: unknown) => void };

/** Stops the live workers of each label of `labels`. A failed stop is a warning. */
export async function stopWork(host: WorkStopHost, labels: readonly string[]): Promise<void> {
	if (labels.length === 0) return;

	try {
		const live = await liveWorkers(host);

		for (const worker of new Set(labels.flatMap((label) => live.get(label) ?? []))) {
			await stopWorker(host, worker).catch(host.warn);
		}
	} catch (cause) {
		host.warn(cause);
	}
}

/**
 * Stops the live workers of each label of the work of the project that ended, a parley or an item that is done or
 * dropped, such as the workers that a message resumed after the end of their work. The host runs it once at its start.
 * A worker of work that the store does not have is left as it is.
 */
export async function stopEndedWork(host: WorkStopHost): Promise<void> {
	try {
		const ended: string[] = [];

		for (const label of (await liveWorkers(host)).keys()) {
			if ((await workState(host.harness, label))?.state === "ended") ended.push(label);
		}

		await stopWork(host, ended);
	} catch (cause) {
		host.warn(cause);
	}
}
