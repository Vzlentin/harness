/**
 * The tree of a project: the project agent, the children by handle, and the started tasks with their child tasks and
 * the conversations of the children library that these tasks own, each with its state and its list of todos.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
	ConversationId,
	ConversationRecord,
	Cursor,
	Page,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskState,
	Tx,
} from "@earendil-works/pi-durable";
import { AGENT_HANDLE } from "../protocol/target.ts";
import type { RunState, TreeNode } from "../protocol/tree.ts";
import { callerHandle, type ChildRecord, ChildRecords, recordsByAge } from "./records.ts";
import { agentTurn, childOf, heldState, library, type TargetHost } from "./targets.ts";
import { entryKinds, StartedTasks, type TaskHost } from "./tasks.ts";
import { readTodos, type TodoOwner } from "./todo.ts";

const context = BACKGROUND_CONTEXT;

/**
 * How many of the newest started tasks keep their nodes that ended. A node that ended and is older than the oldest of
 * them is left out, with the nodes under it.
 */
const WINDOW = 50;

/** The statuses of a task that did not end. */
const LIVE_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"] as const;

/** The items of each page of a scan of the store. */
const PAGE_SIZE = 100;

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** What the tree reads of the host. */
export type TreeHost = Pick<TargetHost, "harness" | "place" | "owner" | "project"> &
	Pick<TaskHost, "root" | "startable">;

/** A node, and the store ID of its conversation or its task, which orders it among its siblings. */
type Placed = { readonly node: TreeNode; readonly order: number };

/** The tasks of the tree, parents first, and the conversations that they own, with the ID of their owner. */
type Runs = {
	readonly tasks: readonly StoredTask[];
	readonly conversations: readonly { readonly record: ConversationRecord; readonly owner: TaskId }[];
};

/**
 * The nodes of the project, each parent before its children, and the siblings in ID order. pi-durable takes the IDs of
 * the tasks and the conversations from one counter, so ID order is creation order.
 */
export async function treeNodes(host: TreeHost): Promise<TreeNode[]> {
	const { harness, place, root } = host;
	const ids = Object.entries((await harness.snapshot(StartedTasks, context))?.tasks ?? {});
	const started = new Map(ids.map(([key, id]): [TaskId, string] => [id, key]));
	const cutoff = [...started.keys()].sort((a, b) => b - a)[WINDOW - 1];
	/** Whether the store ID `id` is not older than the oldest started task of the window. */
	const recent = (id: number) => cutoff === undefined || id >= cutoff;
	const kinds = entryKinds(host.startable);
	const runs = await harness.commit((tx) => scanRuns(tx, root.id, kinds, started, recent), context);
	const records = await harness.snapshot(ChildRecords, context);
	const entries = recordsByAge(records);

	/** The node ID of the task `id`: its key for a started task, else its ID. */
	const runId = (id: TaskId) => `task:${started.get(id) ?? id}`;

	const agent = async (): Promise<Placed> => ({
		order: root.id,
		node: {
			id: AGENT_HANDLE,
			kind: "agent",
			name: `${host.project} agent`,
			state: await agentTurn(place, root).state(context),
			todos: await todosOf(host, { kind: "conversation", id: root.id }),
		},
	});

	const run = async (task: StoredTask): Promise<Placed> => {
		const key = started.get(task.id);

		const node: TreeNode = {
			id: runId(task.id),
			kind: "run",
			name: `${task.kind} ${key ?? task.id}`,
			state: runState(task.state),
			todos: await todosOf(host, { kind: "task", id: task.id }),
		};

		return {
			order: task.id,
			node: key === undefined && task.owner !== undefined ? { ...node, parent: runId(task.owner) } : node,
		};
	};

	const conversation = async (record: ConversationRecord, owner: TaskId): Promise<Placed | undefined> => {
		const child = await library.inspect(place, String(record.id), context);

		if (child === undefined) return undefined;
		const state = await child.state(context);

		if (state === "closed" && !recent(record.id)) return undefined;

		const node: TreeNode = {
			id: `conversation:${record.id}`,
			parent: runId(owner),
			kind: "agent",
			name: child.lineage.key,
			state,
			todos: await todosOf(host, { kind: "conversation", id: record.id }),
		};

		return { order: record.id, node };
	};

	const child = async ([handle, record]: readonly [string, ChildRecord]): Promise<Placed | undefined> => {
		const state = heldState(await (await childOf(host, record)).state(context), records, record.conversationId);

		if (state === "closed" && !recent(record.conversationId)) return undefined;

		const node: TreeNode = {
			id: handle,
			kind: "agent",
			name: record.name ?? handle,
			state,
			todos: await todosOf(host, { kind: "conversation", id: record.conversationId }),
		};

		const parent = await callerNode(host, entries, record.caller);

		return { order: record.conversationId, node: parent === undefined ? node : { ...node, parent } };
	};

	const placed = await Promise.all([
		agent(),
		...runs.tasks.map(run),
		...runs.conversations.map(({ record, owner }) => conversation(record, owner)),
		...entries.map(child),
	]);

	return ordered(placed.filter((one) => one !== undefined));
}

/** The state of the node of a task with the state `state`. */
export function runState(state: TaskState<JsonValue, JsonValue>): RunState {
	switch (state.status) {
		case "pending":
			return "pending";
		case "running":
		case "waiting":
		case "sleeping":
		case "completing":
			return "running";
		case "terminal":
			return outcomeState(state.outcome);
	}
}

function outcomeState(outcome: TaskOutcome<JsonValue>): RunState {
	switch (outcome.status) {
		case "completed":
			return "completed";
		case "aborted":
			return "aborted";
		case "failed":
		case "orphaned":
		case "faulted":
			return "failed";
	}
}

/**
 * The tasks of the tree and the conversations that they own, read in `tx`: each started task of `started` and each task
 * of the kinds `kinds` in the root conversation whose owners lead to a started task. A task that ended and whose ID is
 * not `recent` is left out, with the tasks under it. The scans of the kinds go from the newest task, and stop at the
 * first ID that is not `recent`, so the older tasks that ended are not read.
 */
async function scanRuns(
	tx: Tx,
	rootId: ConversationId,
	kinds: readonly string[],
	started: ReadonlyMap<TaskId, string>,
	recent: (id: number) => boolean,
): Promise<Runs> {
	const found = new Map<TaskId, StoredTask>();

	for (const kind of kinds) {
		const query = { conversationId: rootId, kind } as const;

		const newest = await scanWhile(
			(cursor) => tx.scanTasks({ ...query, order: "descending" }, PAGE_SIZE, cursor),
			(task) => recent(task.id),
		);

		for (const task of newest) found.set(task.id, task);

		for (const status of LIVE_STATUSES) {
			const live = await scanWhile((cursor) => tx.scanTasks({ ...query, status }, PAGE_SIZE, cursor));

			for (const task of live) found.set(task.id, task);
		}
	}

	// A started task of a kind that no entry gives now, such as one of an entry that was removed.
	for (const id of started.keys()) {
		const task = recent(id) && !found.has(id) ? await tx.task(id) : undefined;

		if (task !== undefined) found.set(id, task);
	}

	// A task has a higher ID than its owner, so in ID order each owner comes before the tasks that it owns.
	const tasks: StoredTask[] = [];
	const kept = new Set<TaskId>();

	for (const task of [...found.values()].sort((a, b) => a.id - b.id)) {
		if (!started.has(task.id) && (task.owner === undefined || !kept.has(task.owner))) continue;
		tasks.push(task);
		kept.add(task.id);
	}

	const conversations: { record: ConversationRecord; owner: TaskId }[] = [];

	for (const task of tasks) {
		const owned = await scanWhile((cursor) => tx.scanConversations({ ownerTaskId: task.id }, PAGE_SIZE, cursor));

		for (const record of owned) conversations.push({ record, owner: task.id });
	}

	return { tasks, conversations };
}

/** The items of the pages of `scan`, in its order, up to the first item that `keep` refuses. */
async function scanWhile<T>(
	scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
	keep: (item: T) => boolean = () => true,
): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;

	do {
		const page = await scan(cursor);

		for (const item of page.items) {
			if (!keep(item)) return items;
			items.push(item);
		}

		cursor = page.next;
	} while (cursor !== undefined);

	return items;
}

/**
 * The node of `caller`, the caller of a child: the project agent, a child, or a conversation of the children library;
 * none for a caller that is not a conversation of the host, such as a Pi session or `cli`. A conversation of the library
 * that is not in the tree leaves its children out of it too.
 */
async function callerNode(
	host: TreeHost,
	entries: readonly (readonly [string, ChildRecord])[],
	caller: string,
): Promise<string | undefined> {
	const handle = callerHandle(host.root.id, entries, caller);

	if (handle !== undefined) return handle;

	return (await library.lineage(host.place.store, caller, context)) === undefined
		? undefined
		: `conversation:${caller}`;
}

/** The todos of the list of `owner`, in ID order. */
async function todosOf(host: TreeHost, owner: TodoOwner): Promise<TreeNode["todos"]> {
	return (await readTodos(host.harness, owner, context)).todos;
}

/**
 * The nodes of `placed`, each parent before its children, and the siblings in the order of `order`. A node whose parent
 * is not a node is left out, with the nodes under it.
 */
function ordered(placed: readonly Placed[]): TreeNode[] {
	const children = new Map<string | undefined, TreeNode[]>();

	for (const { node } of [...placed].sort((a, b) => a.order - b.order)) {
		const siblings = children.get(node.parent) ?? [];
		siblings.push(node);
		children.set(node.parent, siblings);
	}

	const nodes: TreeNode[] = [];
	appendSubtrees(children, undefined, nodes);

	return nodes;
}

/** Appends each child of `parent` in `children` to `nodes`, each one followed by the nodes under it. */
function appendSubtrees(
	children: ReadonlyMap<string | undefined, readonly TreeNode[]>,
	parent: string | undefined,
	nodes: TreeNode[],
): void {
	for (const node of children.get(parent) ?? []) {
		nodes.push(node);
		appendSubtrees(children, node.id, nodes);
	}
}
