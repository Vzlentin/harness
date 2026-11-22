/**
 * The workers of the labels: the children of the host and the started tasks that have a label, the started tasks of
 * each label in any state, the changes of a commit that can change a worker, and the stop of a worker.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitChange } from "@earendil-works/pi-durable";
import { CHILD_DOC_KIND } from "../children/library.ts";
import type { Worker } from "../protocol/worker-labels.ts";
import { ChildRecords, recordOf, recordsByAge } from "./records.ts";
import { childEnded, childOf, endChildren, heldState, type TargetHost } from "./targets.ts";
import { liveTaskId, StartedTasks, TaskLabels, type TaskReader, taskWorker } from "./tasks.ts";

const context = BACKGROUND_CONTEXT;

/**
 * The kinds of the documents whose changes can change a worker of a label: the documents of the children, their
 * records, the started tasks and the labels of the tasks. A task becomes live in the commit that writes the started
 * tasks.
 */
const WORKER_DOCS: ReadonlySet<string> = new Set([
	CHILD_DOC_KIND,
	ChildRecords.definition.kind,
	StartedTasks.definition.kind,
	TaskLabels.definition.kind,
]);

/** What the workers read and stop of the host. */
export type WorkerHost = Pick<TargetHost, "harness" | "place" | "owner">;

/**
 * The live workers of each label, children oldest first and then tasks: a child that did not end, `running` while it is
 * busy and `idle` while it is idle or failed, and a started task that is not terminal.
 */
export async function liveWorkers(host: WorkerHost): Promise<ReadonlyMap<string, readonly Worker[]>> {
	const { harness } = host;
	const task: TaskReader = (id) => harness.getTask(id, context);

	const [records, taskLabels, started] = await Promise.all([
		harness.snapshot(ChildRecords, context),
		harness.snapshot(TaskLabels, context),
		harness.snapshot(StartedTasks, context),
	]);

	const byLabel = new Map<string, Worker[]>();

	const add = (labels: readonly string[], worker: Worker) => {
		for (const label of new Set(labels)) byLabel.set(label, [...(byLabel.get(label) ?? []), worker]);
	};

	for (const [handle, record] of recordsByAge(records)) {
		if (record.labels.length === 0) continue;
		const state = heldState(await (await childOf(host, record)).state(context), records, record.conversationId);

		if (state === "ended") continue;
		const conversation = String(record.conversationId);
		add(record.labels, { kind: "agent", handle, conversation, state: state === "busy" ? "running" : "idle" });
	}

	for (const [key, labels] of Object.entries(taskLabels?.labels ?? {})) {
		const worker = await taskWorker(started, key, task);

		if (worker !== undefined) add(labels, worker);
	}

	return byLabel;
}

/** The keys of the started tasks of each label, in any state of the task. */
export async function labelledTasks(host: WorkerHost): Promise<ReadonlyMap<string, readonly string[]>> {
	const taskLabels = await host.harness.snapshot(TaskLabels, context);
	const byLabel = new Map<string, string[]>();

	for (const [key, labels] of Object.entries(taskLabels?.labels ?? {})) {
		for (const label of new Set(labels)) byLabel.set(label, [...(byLabel.get(label) ?? []), key]);
	}

	return byLabel;
}

/**
 * Whether `change`, a change of a commit, can change a live worker of a label: a change of a child, of the record of a
 * child, of the started tasks or of the labels of the tasks, or a task that ends.
 */
export function workersChange(change: CommitChange): boolean {
	if (change.type === "task") return change.value.state.status === "terminal";

	return change.type === "document" && WORKER_DOCS.has(change.record.kind);
}

/** The live workers of `label`. */
export async function workers(host: WorkerHost, label: string): Promise<readonly Worker[]> {
	return (await liveWorkers(host)).get(label) ?? [];
}

/**
 * Stops `worker`: a child ends with the children that it spawned, as a `stop` does, and a task is aborted. A worker
 * that already ended, or a task that is terminal, is left as it is.
 */
export async function stopWorker(host: WorkerHost, worker: Worker): Promise<void> {
	const { harness } = host;

	if (worker.kind === "agent") {
		const record = recordOf(await harness.snapshot(ChildRecords, context), worker.handle);

		if (record === undefined || (await childEnded(host, record))) return;
		await endChildren(host, [record], { keepAnswers: false });

		return;
	}

	const started = await harness.snapshot(StartedTasks, context);
	const id = await liveTaskId(started, worker.key, (task) => harness.getTask(task, context));

	if (id !== undefined) await harness.abortTask(id, context);
}
