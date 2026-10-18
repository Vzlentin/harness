/**
 * The tasks that clients start in the host: the tasks of the `piDurable` entries, as background tasks of the root
 * conversation, by the client's key.
 */
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AnyTask, Conversation, Extension, Harness, Task, TaskId } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import type { Request, TaskInfo } from "./protocol.ts";

const context = BACKGROUND_CONTEXT;

/** The tasks that `start` created, by client key. A key is never removed. */
const StartedTasks = durable.defineDoc<{ tasks: Record<string, TaskId<JsonValue>> }>({
	kind: "harness.tasks",
	version: 1,
	scope: "session",
	initial: () => ({ tasks: {} }),
});

/** What the task requests use of the host. */
export type TaskHost = {
	readonly harness: Harness;
	/** The root conversation, which owns the started tasks. */
	readonly root: Conversation;
	/** The tasks that `start` can create, from `startableTasks`. */
	readonly startable: Extension;
	/** Aborted when the connection of the request closes. */
	readonly signal: AbortSignal;
};

/**
 * The extension of the tasks of the `piDurable` entries, which is the list of the kinds that `start` can create. The
 * registry refuses a task name that two entries give.
 */
export function startableTasks(tasks: readonly AnyTask[]): Extension {
	return durable.defineExtension({ name: "harness-entry-tasks", tasks });
}

/**
 * Starts the task of `request.key` once. It is a background task of the root conversation, so an abort of the project
 * agent's turn does not reach it. The key is written in the commit that creates the task, so a start after a crash
 * finds it.
 */
export async function startTask(host: TaskHost, request: Extract<Request, { type: "start" }>): Promise<TaskInfo> {
	await host.root.commit(async (tx) => {
		const state = await tx.doc(StartedTasks);
		if (Object.hasOwn(state.tasks, request.key)) return;
		state.tasks[request.key] = await tx.createTask(startableTask(host.startable, request.kind), request.input, {
			ownership: { kind: "conversation" },
			background: true,
		});
	}, context);
	return taskInfo(host.harness, request.key);
}

/** The info of the task that `start` created for `key`. */
export async function taskInfo(harness: Harness, key: string): Promise<TaskInfo> {
	const id = await taskId(harness, key);
	const record = await harness.getTask(id, context);
	if (record === undefined) throw new Error(`Missing task ${id}`);
	return {
		key,
		id,
		kind: record.kind,
		version: record.version,
		status: record.state.status,
		...(record.state.status === "terminal" ? { outcome: record.state.outcome } : {}),
	};
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
async function taskId(harness: Harness, key: string): Promise<TaskId<JsonValue>> {
	const state = await harness.snapshot(StartedTasks, context);
	const id = state != null && Object.hasOwn(state.tasks, key) ? state.tasks[key] : undefined;
	if (id === undefined) throw new Error(`Unknown task: ${key}`);
	return id;
}

/** The task of `kind` in `startable`. The entries give erased tasks, so this is where they get the type of `createTask`. */
function startableTask(startable: Extension, kind: string): Task<JsonValue, { phase: string }, JsonValue, object> {
	const task = startable.tasks?.find((found) => found.definition.name === kind);
	if (task === undefined) throw new Error(`Unknown task kind: ${kind}`);
	return task as Task<JsonValue, { phase: string }, JsonValue, object>;
}
