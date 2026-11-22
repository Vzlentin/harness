/**
 * The tasks that clients start in the host: the tasks of the entries, as background tasks of the root
 * conversation, by the client's key, with their labels.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Conversation, Extension, Harness, Task, TaskId, TaskRecord } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Request, TaskInfo } from "../protocol/requests.ts";
import { SpawnServes, type Worker, workerLabels } from "../protocol/worker-labels.ts";
import { boundedReplay } from "./checkpoint.ts";
import { WorkerRefs, workerRefs } from "./worker-refs.ts";

const context = BACKGROUND_CONTEXT;

/** The task ID of each `start` key. A key is never removed. */
export type StartedTaskIds = { tasks: Record<string, TaskId<JsonValue>> };

/** The tasks that `start` created, by client key. Clients that read the store file find the task of a key here. */
export const StartedTasks = durable.defineDoc<StartedTaskIds>({
	kind: "harness.tasks",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ tasks: {} }),
});

/** The labels of each started task by `start` key, for a task that has one. A key is never removed. */
export const TaskLabels = durable.defineDoc<{ labels: Record<string, string[]> }>({
	kind: "harness.task-labels",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ labels: {} }),
});

/** A task input with the `serves` of a spawn, which gives the task its label. */
const ServesTaskInput = Type.Object({ serves: SpawnServes });

/** What the task requests use of the host. */
export type TaskHost = {
	readonly harness: Harness;
	/** The root conversation, which owns the started tasks. */
	readonly root: Conversation;
	/** The tasks that `start` can create: the tasks of the entries. */
	readonly startable: Extension;
	/** Aborted when the connection of the request closes. */
	readonly signal: AbortSignal;
	/** Refuses `labels` with the reason of the first label that the check of its kind refuses. */
	readonly checkLabels: (labels: readonly string[]) => Promise<void>;
};

/**
 * Starts the task of `request.key` once. It is a background task of the root conversation, so an abort of the project
 * agent's turn does not reach it. The key is written in the commit that creates the task, so a start after a crash
 * finds it. A repeat for a known key refuses another kind than the task's, and a version that the loaded definition
 * does not have, as a first start does. A first start checks the labels of the task (`taskLabels`) before its commit,
 * which writes them.
 */
export async function startTask(host: TaskHost, request: Extract<Request, { type: "start" }>): Promise<TaskInfo> {
	const labels = taskLabels(request);
	const started = await host.harness.snapshot(StartedTasks, context);

	if (labels.length > 0 && startedTaskId(started, request.key) === undefined) {
		await host.checkLabels(labels);
	}

	await host.root.commit(async (tx) => {
		const state = await tx.doc(StartedTasks);
		const known = startedTaskId(state, request.key);

		if (known !== undefined) {
			const record = await tx.task(known);

			if (record !== undefined && record.kind !== request.kind) {
				throw new Error(`The task ${request.key} is a ${record.kind} task, not ${request.kind}`);
			}
		}

		const task = startableTask(host.startable, request.kind);

		if (request.version !== undefined && task.definition.version !== request.version) {
			throw new Error(
				`This host has version ${task.definition.version} of ${request.kind}, not ${request.version}: stop the host so it starts again with the installed version`,
			);
		}

		if (known !== undefined) return;
		state.tasks[request.key] = await tx.createTask(task, request.input, {
			ownership: { kind: "conversation" },
			background: true,
		});

		if (labels.length > 0) (await tx.doc(TaskLabels)).labels[request.key] = labels;
	}, context);

	return taskInfo(host.harness, request.key);
}

/** The labels of the task of `request`: its `labels`, then the label of the `serves` of its input, each once. */
function taskLabels(request: Extract<Request, { type: "start" }>): string[] {
	return workerLabels(request.labels, Value.Check(ServesTaskInput, request.input) ? request.input.serves : undefined);
}

/** The ID of the task that `start` created for `key` in `started`, or nothing for a key that no `start` gave. */
export function startedTaskId(
	started: Readonly<StartedTaskIds> | undefined,
	key: string,
): TaskId<JsonValue> | undefined {
	return started !== undefined && Object.hasOwn(started.tasks, key) ? started.tasks[key] : undefined;
}

/** Reads a task by ID, from the harness or in a commit, and gives nothing for an unknown ID. */
export type TaskReader = (id: TaskId<JsonValue>) => Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;

/** The ID of the task of `key` in `started` while it is live: started and not terminal. `task` reads the task. */
export async function liveTaskId(
	started: Readonly<StartedTaskIds> | undefined,
	key: string,
	task: TaskReader,
): Promise<TaskId<JsonValue> | undefined> {
	const id = startedTaskId(started, key);
	const record = id === undefined ? undefined : await task(id);

	return record !== undefined && record.state.status !== "terminal" ? id : undefined;
}

/** The worker of the started task of `key` while it is live, as `liveTaskId` finds it, and else nothing. */
export async function taskWorker(
	started: Readonly<StartedTaskIds> | undefined,
	key: string,
	task: TaskReader,
): Promise<Worker | undefined> {
	return (await liveTaskId(started, key, task)) === undefined ? undefined : { kind: "task", key, state: "running" };
}

/** The info of the task that `start` created for `key`, with its result references when it has one. */
export async function taskInfo(harness: Harness, key: string): Promise<TaskInfo> {
	const id = await taskId(harness, key);
	const record = await harness.getTask(id, context);

	if (record === undefined) throw new Error(`Missing task ${id}`);

	const refs = workerRefs(await harness.snapshot(WorkerRefs, context), { kind: "task", key });
	const info: TaskInfo = { key, id, kind: record.kind, version: record.version, status: record.state.status, ...refs };

	return record.state.status === "terminal" ? { ...info, outcome: record.state.outcome } : info;
}

/** Waits until the task of `key` is terminal, or the connection closes, and gives its info with the outcome. */
export async function waitTask(host: TaskHost, key: string): Promise<TaskInfo> {
	await host.harness.waitForTask(await taskId(host.harness, key), withAbortSignal(host.signal, context));

	return taskInfo(host.harness, key);
}

/** Aborts the task of `key`. The abort reaches the conversations that the task owns, and their turns. */
export async function abortTask(harness: Harness, key: string): Promise<TaskInfo> {
	await harness.abortTask(await taskId(harness, key), context);

	return taskInfo(harness, key);
}

/** The ID of the task that `start` created for `key`. */
export async function taskId(harness: Harness, key: string): Promise<TaskId<JsonValue>> {
	const id = startedTaskId(await harness.snapshot(StartedTasks, context), key);

	if (id === undefined) throw new Error(`Unknown task: ${key}`);

	return id;
}

/** The kinds of the tasks of `startable`, which `start` can create. */
export function entryKinds(startable: Extension): string[] {
	return (startable.tasks ?? []).map((task) => task.definition.name);
}

/** The task of `kind` in `startable`. The entries give erased tasks, so this is where they get the type of `createTask`. */
function startableTask(startable: Extension, kind: string): Task<JsonValue, { phase: string }, JsonValue, object> {
	const task = startable.tasks?.find((found) => found.definition.name === kind);

	if (task === undefined) throw new Error(`Unknown task kind: ${kind}`);

	// SAFETY: `AnyTask` is a `Task` with its types erased. The store keeps the input, the phase state and the result of
	// every task as JSON.
	return task as Task<JsonValue, { phase: string }, JsonValue, object>;
}
