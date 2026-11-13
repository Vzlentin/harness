/**
 * The watch of the tree of a project: the nodes, then an event with the nodes that changed after the commits that can
 * change a node, and one with the nodes that went.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type CommitChange,
	type ConversationId,
	type DocumentCommitChange,
	LiveDoc,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { CHILD_DOC_KIND } from "../children/library.ts";
import type { Replies } from "../protocol/requests.ts";
import { TASK_TODO_LIST_KIND, TODO_LIST_KIND } from "../protocol/todo.ts";
import type { RunState, TreeEvent, TreeNode } from "../protocol/tree.ts";
import type { Connection } from "./push.ts";
import { ChildRecords } from "./records.ts";
import { type StoreView, serveStoreWatch } from "./store-watch.ts";
import { AgentState } from "./targets.ts";
import { entryKinds, StartedTasks } from "./tasks.ts";
import { runState, type TreeHost, treeNodes } from "./tree.ts";

/**
 * The kinds of the documents whose changes can change a node: the lists of todos, the last request of the project
 * agent, the records of the children by handle, the started tasks, and the documents of the conversations of the
 * children library.
 */
const NODE_DOCS: ReadonlySet<string> = new Set([
	TODO_LIST_KIND,
	TASK_TODO_LIST_KIND,
	AgentState.definition.kind,
	ChildRecords.definition.kind,
	StartedTasks.definition.kind,
	CHILD_DOC_KIND,
]);

/**
 * Opens a watch of the tree on `connection`, and returns the reply, with the nodes. A pass runs once the reply is
 * written, and after it each commit that can change a node starts a pass: the host builds the tree again and sends
 * `{ event: { nodes } }` with the nodes that are new or changed, in tree order, then `{ event: { removed } }` with the
 * IDs of the nodes that went, each only when it is not empty. The passes run one at a time, and the commits during a
 * pass give one more pass. When a write waits for a slow socket to drain, the next `nodes` event has every node. A pass
 * that fails, and the close of the store, end the connection. The watch stops when the socket closes.
 */
export async function serveTreeWatch(
	handler: TreeHost & { readonly signal: AbortSignal },
	connection: Connection,
): Promise<Replies["watch-tree"]> {
	const nodes = await serveStoreWatch(handler.harness, new TreeView(handler), handler.signal, connection);

	return { nodes };
}

/** The tree of a project, and the commits that can change a node. */
class TreeView implements StoreView<TreeNode[], TreeEvent> {
	readonly #host: TreeHost;
	/** The kinds of the tasks of the entries. */
	readonly #kinds: ReadonlySet<string>;
	/** Whether the live document of each conversation had a run, in the last change of it that the watch saw. */
	readonly #runs = new Map<ConversationId, boolean>();
	/** The node state of each task of the entries, in the last change that the watch saw. */
	readonly #states = new Map<TaskId, RunState>();

	constructor(host: TreeHost) {
		this.#host = host;
		this.#kinds = new Set(entryKinds(host.startable));
	}

	read(): Promise<TreeNode[]> {
		return treeNodes(this.#host);
	}

	/** The nodes of `after` that are new or changed, with every node when `all` is true, then the IDs of those that went. */
	events(before: TreeNode[], after: TreeNode[], all: boolean): TreeEvent[] {
		const sent = nodeTexts(before);
		const texts = nodeTexts(after);
		const changed = all ? [...after] : after.filter((node) => sent.get(node.id) !== texts.get(node.id));
		const removed = [...sent.keys()].filter((id) => !texts.has(id));
		const events: TreeEvent[] = [];

		if (changed.length > 0) events.push({ nodes: changed });

		if (removed.length > 0) events.push({ removed });

		return events;
	}

	/** Whether `change` can change a node. It keeps the maps of the live runs and of the task states current. */
	changes(change: CommitChange): boolean {
		switch (change.type) {
			case "submission":
				return true;
			case "task":
				return this.#stateChanged(change.value);
			case "document":
				return (
					NODE_DOCS.has(change.record.kind) ||
					(change.record.kind === LiveDoc.definition.kind && this.#runChanged(change))
				);
			default:
				return false;
		}
	}

	/**
	 * Whether the live document of `change` starts or ends a run. It changes with each streamed part of an answer, and
	 * only the start and the end of a run change a state. The first change of a conversation counts as a change, because
	 * the watch does not know if the reply had a run.
	 */
	#runChanged(change: Extract<DocumentCommitChange, { type: "document" }>): boolean {
		const id = change.conversationId;

		if (id === undefined) return false;
		const running = change.kind === "change" && change.value.run !== undefined;
		const before = this.#runs.get(id);
		this.#runs.set(id, running);

		return before !== running;
	}

	/** Whether `task`, a task of a commit, is a new task of the entries or has a new node state. A checkpoint does not. */
	#stateChanged(task: TaskRecord<JsonValue, JsonValue, JsonValue>): boolean {
		if (!this.#kinds.has(task.kind)) return false;
		const state = runState(task.state);
		const before = this.#states.get(task.id);
		this.#states.set(task.id, state);

		return before !== state;
	}
}

/** The JSON of each of `nodes`, by node ID. */
function nodeTexts(nodes: readonly TreeNode[]): Map<string, string> {
	return new Map(nodes.map((node) => [node.id, JSON.stringify(node)]));
}
