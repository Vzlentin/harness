/**
 * The watch of a mirror: the view of one conversation with its list of todos, then a line for each of its commits, each
 * change of its list and each rename.
 */
import { once } from "node:events";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import type { Conversation, ConversationView, DocumentWatch } from "@earendil-works/pi-durable";
import { endAfter } from "../children/library.ts";
import type { ChildInfo, Replies, WatchLine } from "../protocol/requests.ts";
import type { Target } from "../protocol/target.ts";
import { TODO_LIST_KIND, type TodoList } from "../protocol/todo.ts";
import { type ViewChange, viewChange } from "../protocol/view-change.ts";
import { watchCommits } from "./commit-watch.ts";
import type { Connection } from "./push.ts";
import { ChildRecords, type ChildrenState, recordOf } from "./records.ts";
import { childInfo, type Found, type TargetHost, target } from "./targets.ts";
import { watchTodos } from "./todo.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Opens a watch of `ref` on `connection` and returns the reply, with the view and the child. After the reply, each
 * commit to the child's conversation gives one `{ event: WatchLine }` line with its change, each change of its list of
 * todos one with the list in `docs`, and each rename one with an empty change. The reply and each line of the whole
 * view have the list in `docs` when the conversation has one. It waits for a slow socket to drain, so the watches
 * replace the frames they hold back with one frame of the whole view or of the newest list. The watches stop when the
 * socket closes, when setup fails, or when the connection ends; a wait for `drain` then stays on the closed socket and
 * goes with it. An end or a resume of the conversation gives one line with an empty change, so the info has the new
 * state. When the conversation watch or the list watch ends, the connection ends.
 */
export async function serveWatch(
	handler: TargetHost & { readonly signal: AbortSignal },
	ref: Target,
	connection: Connection,
): Promise<Replies["watch"]> {
	const { harness } = handler;
	const { socket } = connection;
	const write = (event: WatchLine) => socket.write(`${JSON.stringify({ event })}\n`);
	// The watches stop when `signal` aborts: on socket close, or when `watching` aborts.
	const watching = new AbortController();
	const watchContext = withAbortSignal(AbortSignal.any([handler.signal, watching.signal]), context);

	const end = () => {
		watching.abort();

		if (socket.writable) socket.end();
	};

	let found: Found;
	/** The `ChildRecords` watch of a child target, and its handle. */
	let children: { readonly watch: DocumentWatch<ChildrenState>; readonly handle: string } | undefined;
	let conversation: Awaited<ReturnType<Conversation["watch"]>>;
	/** The watch of the list of todos of the conversation, which pi-durable's view does not have. */
	let todos: WatchHandle<Readonly<TodoList> | null>;
	/** The watch of the end of the conversation, which the library marks outside the view: true while it is ended. */
	let ended: WatchHandle<boolean>;
	let last: ChildInfo;

	try {
		found = await target(handler, ref);

		// The host agent and a conversation target have no record and no `ChildRecords` watch: they are never renamed.
		if (ref.kind === "child") {
			const { handle } = ref;
			// The `ChildRecords` watch opens before the info, so it gets each later rename of the child.
			const watch = await harness.watchDoc(ChildRecords, watchContext);
			const record = recordOf(watch?.value, handle);

			if (watch === undefined || record === undefined) throw new Error(`Unknown subagent: ${handle}`);
			children = { watch, handle };
			found = { ...found, record, info: () => childInfo(handler, handle, record) };
		}

		const { id } = found.conversation;
		const info = found.info;
		ended = await watchCommits(
			harness,
			async () => (await info()).state === "ended",
			(change) => endAfter(change, id),
			watchContext,
		);
		last = await found.info();
		todos = await watchTodos(harness, id, watchContext);
		conversation = await found.conversation.watch(watchContext);
	} catch (error) {
		watching.abort();
		throw error;
	}

	const childrenWatch = children;
	// A watch delivers the frames held before `start` in a microtask, so the watches start after the reply is written.
	connection.afterReply(() => {
		// Only microtasks run between the last `await` above and this call, so a socket close cannot abort the signal
		// before the watches start.
		void conversation.closed.then(end);
		void todos.closed.then(end);
		void ended.closed.then(end);
		// A watch runs its own callbacks in order, but not in order with the other watches. All the watches write through
		// this one chain, so a line never has older info than the line before it.
		let queue: Promise<void> = Promise.resolve();

		/** Writes the line of `change`, with the info of now. */
		const writeLine = async (change: ViewChange) => {
			// Some store reads per commit; cache the agent fields if streaming gets slow. A store failure drops this
			// line.
			const child = await found.info().catch(() => undefined);

			if (child === undefined || !socket.writable) return;
			// pi-durable's view has no list, so a line of the whole view gets the newest list of the list watch.
			const whole = "view" in change ? { view: withTodos(change.view, todos.value) } : change;

			if (!write({ change: whole, child })) await once(socket, "drain").catch(() => {});
		};

		const send = (change: ViewChange) => {
			queue = queue.then(() => writeLine(change));

			return queue;
		};

		if (childrenWatch !== undefined) {
			const { watch, handle } = childrenWatch;

			// A retired `ChildRecords` document has no records. Durable never calls with a failure.
			watch.start(async (call) => {
				if (!socket.writable || call.kind !== "value") return;
				const next = recordOf(call.retired ? undefined : call.value, handle);

				if (next !== undefined && next.name !== found.record?.name) {
					found = { ...found, record: next, info: () => childInfo(handler, handle, next) };
					await send({});
				}
			});
		}

		conversation.start(async (call) => {
			if (call.kind === "value") await send(viewChange(call.value, call.ops));
		});

		todos.start(async (call) => {
			if (call.kind === "value") await send({ docs: { [TODO_LIST_KIND]: call.value } });
		});

		// Each change of the document of the child gives a call; only an end or a resume gives a line.
		let wasEnded = ended.value;

		ended.start(async (call) => {
			if (call.kind !== "value" || call.value === wasEnded) return;
			wasEnded = call.value;
			await send({});
		});
	});

	return { view: withTodos(conversation.value, todos.value), child: last };
}

/** `view` with the list of todos `list` of its conversation, when it has one. */
function withTodos(view: ConversationView, list: Readonly<TodoList> | null): ConversationView {
	if (list === null) return view;

	return { ...view, docs: { ...view.docs, [TODO_LIST_KIND]: list } };
}
