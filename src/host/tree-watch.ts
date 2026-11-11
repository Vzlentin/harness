/**
 * The watch of the tree of a project: the nodes, then an event with the nodes that changed after the commits that can
 * change a node, and one with the nodes that went.
 */
import { once } from "node:events";
import type { Socket } from "node:net";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type CommitChange,
	type CommitObservation,
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
import { Passes } from "./passes.ts";
import type { Connection } from "./push.ts";
import { ChildRecords } from "./records.ts";
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
	// The observer attaches before the first tree is built, so a commit during the build gives a pass.
	const watch = new TreeWatch(handler, connection.socket);
	let nodes: TreeNode[];

	try {
		nodes = await watch.open();
	} catch (error) {
		watch.stop();
		throw error;
	}

	if (handler.signal.aborted) watch.stop();
	else handler.signal.addEventListener("abort", () => watch.stop(), { once: true });
	// The events come after the reply.
	connection.afterReply(() => watch.start());

	return { nodes };
}

/** The passes of one watch of the tree, and what its client has. */
class TreeWatch {
	readonly #host: TreeHost;
	readonly #socket: Socket;
	/** The kinds of the tasks of the entries. */
	readonly #kinds: ReadonlySet<string>;
	readonly #observation: CommitObservation;
	readonly #passes = new Passes(() => this.#pass().catch(() => this.#end()));
	/** Whether the live document of each conversation had a run, in the last change of it that the watch saw. */
	readonly #runs = new Map<ConversationId, boolean>();
	/** The node state of each task of the entries, in the last change that the watch saw. */
	readonly #states = new Map<TaskId, RunState>();
	/** The JSON of each node that the client has, by node ID. */
	#sent = new Map<string, string>();
	/** Whether the reply is written, so the commits give passes. */
	#started = false;
	/** Whether the last write waited for the socket to drain, so the next event has every node. */
	#behind = false;

	constructor(host: TreeHost, socket: Socket) {
		this.#host = host;
		this.#socket = socket;
		this.#kinds = new Set(entryKinds(host.startable));
		// The listener only requests a pass: it must not call the store. It reads every change, so its maps stay current.
		this.#observation = host.harness.observeCommits({
			advance: (publication) => {
				const marks = publication.changes.map((change) => this.#changesNode(change));

				if (this.#started && marks.includes(true)) this.#passes.request();
			},
			end: () => this.#end(),
		});
	}

	/** Builds the tree that the reply gives, which the client then has. */
	async open(): Promise<TreeNode[]> {
		const nodes = await treeNodes(this.#host);
		this.#sent = nodeTexts(nodes);

		return nodes;
	}

	/**
	 * Lets the passes run, once the reply is written, and runs one. It sends the nodes that changed since the reply, so
	 * the commits before it need no pass of their own.
	 */
	start(): void {
		this.#started = true;
		this.#passes.request();
	}

	/** Stops the passes. */
	stop(): void {
		this.#passes.stop();
		this.#observation.detach();
	}

	/** Stops the passes and ends the connection. */
	#end(): void {
		this.stop();

		if (this.#socket.writable) this.#socket.end();
	}

	/**
	 * Builds the tree, and sends the nodes that the client does not have and the IDs of those that went. When it fails,
	 * the watch ends the connection, and the client opens the watch again to get a whole tree.
	 */
	async #pass(): Promise<void> {
		const nodes = await treeNodes(this.#host);

		if (this.#passes.stopped || !this.#socket.writable) return;
		const texts = nodeTexts(nodes);
		const changed = this.#behind ? nodes : nodes.filter((node) => this.#sent.get(node.id) !== texts.get(node.id));
		const removed = [...this.#sent.keys()].filter((id) => !texts.has(id));
		const events: TreeEvent[] = [];

		if (changed.length > 0) events.push({ nodes: changed });

		if (removed.length > 0) events.push({ removed });
		this.#sent = texts;
		this.#behind = false;
		const writes = events.map((event) => this.#socket.write(`${JSON.stringify({ event })}\n`));

		if (writes.includes(false)) {
			this.#behind = true;
			// A socket that closes first never drains: the wait then goes with it.
			await once(this.#socket, "drain").catch(() => {});
		}
	}

	/** Whether `change` can change a node. It keeps the maps of the live runs and of the task states current. */
	#changesNode(change: CommitChange): boolean {
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
