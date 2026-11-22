/**
 * The stops of the workers of the work of the project: the workers of a parley or an item that ended, but the worker
 * whose report ended it. The agent that ended the work stops after its turn.
 */
import type { EntryHandles } from "../host/entries.ts";
import type { WorkerId, Worker } from "../protocol/worker-labels.ts";
import { type WorkReader, workState } from "./work-state.ts";

/** What the stops of the workers use of the host. */
export type WorkStopHost = Pick<EntryHandles, "liveWorkers" | "stop" | "stopAfterTurn" | "warn"> & {
	/** The project store, with the parleys and the items. */
	readonly store: WorkReader;
};

/**
 * The worker that triggered a stop of the work, and what the stop does with it. `match` is the worker by its ID, or an
 * agent by its conversation. `stop` is `spare`, which leaves it running, or `after-turn`, which stops an agent after its
 * turn.
 */
export type WorkTrigger = {
	readonly match: WorkerId | { readonly kind: "agent"; readonly conversation: string };
	readonly stop: "spare" | "after-turn";
};

/** The trigger of a stop of the work by the request of `caller`: the agent whose conversation it is stops after its turn. */
export function afterTurn(caller: string): WorkTrigger {
	return { match: { kind: "agent", conversation: caller }, stop: "after-turn" };
}

/**
 * Stops the live workers of each label of `labels`, and awaits them, but the worker of `by`: a spared worker keeps
 * running, and an agent that stops after its turn is not awaited. A failed stop is a warning.
 */
export async function stopWork(host: WorkStopHost, labels: readonly string[], by?: WorkTrigger): Promise<void> {
	if (labels.length === 0) return;

	try {
		const live = await host.liveWorkers();

		for (const worker of new Set(labels.flatMap((label) => live.get(label) ?? []))) {
			const action = by !== undefined && sameWorker(worker, by.match) ? by.stop : "now";

			if (action === "spare") continue;

			if (action === "after-turn" && worker.kind === "agent") void host.stopAfterTurn(worker).catch(host.warn);
			else await host.stop(worker).catch(host.warn);
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
			if (workState(host.store, label)?.state === "ended") ended.push(label);
		}

		await stopWork(host, ended);
	} catch (cause) {
		host.warn(cause);
	}
}

/** Whether `worker` is `other`: the same kind, and the same key, or for an agent the same handle or conversation. */
function sameWorker(worker: Worker, other: WorkTrigger["match"]): boolean {
	if (other.kind === "task") return worker.kind === "task" && worker.key === other.key;

	if (worker.kind !== "agent") return false;

	return "handle" in other ? other.handle === worker.handle : other.conversation === worker.conversation;
}
