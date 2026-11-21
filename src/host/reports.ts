/**
 * The reports of the result references of the workers: the `report` request stores them for a child or a started
 * task, and then the handlers of the reports of the entries run, in load order, before the reply.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Replies, Request } from "../protocol/requests.ts";
import { AGENT_HANDLE } from "../protocol/target.ts";
import type { WorkerId } from "../protocol/worker-labels.ts";
import type { ReportedEvent, ReportedHandler } from "./entries.ts";
import { callerHandle, type ChildRecord, ChildRecords, recordOf, recordsByAge } from "./records.ts";
import { TaskLabels, type TaskHost, taskId } from "./tasks.ts";
import { addRefs, WorkerRefs } from "./worker-refs.ts";

const context = BACKGROUND_CONTEXT;

/** What a report uses of the host. */
export type ReportHost = Pick<TaskHost, "harness" | "root"> & {
	/** The handlers of the reports of the entries, in load order. */
	readonly reported: readonly ReportedHandler[];
};

/**
 * Stores the references of `request` for its worker, each once, and gives all the references of the worker. After the
 * commit, each handler of `host.reported` runs in order with the references of this report. A throw of a handler fails
 * the request, the later handlers do not run, and the references stay, so a repeat runs the handlers again.
 */
export async function report(
	request: Extract<Request, { type: "report" }>,
	host: ReportHost,
): Promise<Replies["report"]> {
	const { worker, labels } = await reportedWorker(request, host);

	const refs = await host.harness.commit(
		async (tx) => addRefs(await tx.doc(WorkerRefs), worker, request.refs),
		context,
	);

	const event: ReportedEvent = { worker, labels, refs: request.refs, caller: request.caller };

	for (const handler of host.reported) await handler(event);

	return { refs };
}

/**
 * The worker of `request` and its labels: the child `handle`, the started task `key`, or the child whose conversation
 * is the caller. The project agent and a caller that is no child refuse a report with no worker.
 */
async function reportedWorker(
	request: Extract<Request, { type: "report" }>,
	host: ReportHost,
): Promise<{ readonly worker: WorkerId; readonly labels: readonly string[] }> {
	const { harness } = host;

	if (request.key !== undefined) {
		await taskId(harness, request.key);
		const labels = (await harness.snapshot(TaskLabels, context))?.labels ?? {};

		return {
			worker: { kind: "task", key: request.key },
			labels: Object.hasOwn(labels, request.key) ? (labels[request.key] ?? []) : [],
		};
	}

	const records = await harness.snapshot(ChildRecords, context);
	const handle = request.handle ?? ownHandle(host.root.id, recordsByAge(records), request.caller);
	const record = recordOf(records, handle);

	if (record === undefined) throw new Error(`Unknown subagent: ${handle}`);

	return { worker: { kind: "agent", handle }, labels: record.labels };
}

/** The handle of the child whose conversation is `caller` in `entries`. Another caller fails. */
function ownHandle(
	rootId: ConversationId,
	entries: readonly (readonly [string, ChildRecord])[],
	caller: string,
): string {
	const handle = callerHandle(rootId, entries, caller);

	if (handle === undefined || handle === AGENT_HANDLE) {
		throw new Error("The caller is no worker of this host: give handle or key");
	}

	return handle;
}
