/**
 * The lists of todos in the store: one for each conversation, one for each task that `start` created, and one for each
 * caller that is not a conversation of the host, such as a Pi session. The `todo` request of the host and the tasks of
 * the entries change them with these functions, in their own commits.
 */
import type { Context } from "@earendil-works/chord/context";
import { Watch, type WatchCall, type WatchEnd, type WatchHandle } from "@earendil-works/chord/watch";
import type { CommitChange, ConversationId, DocumentReader, Session, TaskId, Tx } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { TASK_TODO_LIST_KIND, TODO_LIST_KIND, type Todo, type TodoList, type TodoState } from "../protocol/todo.ts";

export * from "../protocol/todo.ts";

/** Whose list: a conversation, a task, or a caller that is not a conversation of the host. */
export type TodoOwner =
	| { readonly kind: "conversation"; readonly id: ConversationId }
	| { readonly kind: "task"; readonly id: TaskId }
	| { readonly kind: "caller"; readonly caller: string };

/** The list of a conversation. */
const ConversationTodos = durable.defineDoc<TodoList>({
	kind: TODO_LIST_KIND,
	version: 1,
	scope: "conversation",
	history: "latest",
	checkpointWhen: () => false,
	fork: "initial",
	initial: () => ({ todos: [] }),
});

/**
 * The list of a task, by task ID. It is a document of the session, not of the task, so it stays after the commit that
 * makes the task terminal.
 */
const TaskTodos = durable.defineDocFamily<TodoList, null>({
	kind: TASK_TODO_LIST_KIND,
	version: 1,
	scope: "session",
	checkpointWhen: () => false,
	family: true,
	initial: () => ({ todos: [] }),
});

/** The list of a caller that is not a conversation of the host, by caller. */
const CallerTodos = durable.defineDocFamily<TodoList, null>({
	kind: "harness.caller-todos",
	version: 1,
	scope: "session",
	checkpointWhen: () => false,
	family: true,
	initial: () => ({ todos: [] }),
});

/** Adds a todo with the state `open` to the list of `owner` in `tx`, with the next ID of the list, and gives it. */
export async function addTodo(tx: Tx, owner: TodoOwner, text: string): Promise<Todo> {
	refuseEmpty(text);
	const list = await draftOf(tx, owner);
	const todo: Todo = { id: (list.todos.at(-1)?.id ?? 0) + 1, text, state: "open" };
	list.todos.push({ ...todo });

	return todo;
}

/**
 * Sets the state of the todo `change.id` of the list of `owner` in `tx`, and its text with `change.text`, and gives the
 * todo.
 */
export async function setTodo(
	tx: Tx,
	owner: TodoOwner,
	change: { readonly id: number; readonly state: TodoState; readonly text?: string | undefined },
): Promise<Todo> {
	if (change.text !== undefined) refuseEmpty(change.text);
	const list = await draftOf(tx, owner);
	const todo = list.todos.find((found) => found.id === change.id);

	if (todo === undefined) throw new Error(`Unknown todo: ${change.id}`);
	todo.state = change.state;

	if (change.text !== undefined) todo.text = change.text;

	// A draft cannot be used after its commit, so the todo is a copy.
	return { id: todo.id, text: todo.text, state: todo.state };
}

/** The list of `owner`, read from `reader`, such as the harness or the runtime of a task. A list never changed is empty. */
export async function readTodos(
	reader: Pick<DocumentReader, "snapshot">,
	owner: TodoOwner,
	context: Context,
): Promise<TodoList> {
	const list = await snapshotOf(reader, owner, context);

	return { todos: (list?.todos ?? []).map((todo) => ({ ...todo })) };
}

/**
 * A watch of the list of the conversation `id`, from the list now: its value is the list, or `null` while the
 * conversation has none. Each stored commit that changes the list gives a call, also the commit that creates it, which a
 * `watchDoc` of an absent document cannot give. Aborting `context` ends it, as does the close of `session`. A throw
 * of its listener ends it, and `closed` gives the error.
 */
export async function watchTodos(
	session: Pick<Session, "observeCommits" | "snapshot">,
	id: ConversationId,
	context: Context,
): Promise<WatchHandle<Readonly<TodoList> | null>> {
	// The observer attaches before the read, so no commit goes between them. The newest list of a commit during the read
	// goes to the watch once it exists: at worst the list of the read again.
	let watch: Watch<Readonly<TodoList> | null> | undefined;
	let early: { readonly list: Readonly<TodoList> | null; readonly context: Context } | undefined;
	let ended: WatchEnd | undefined;

	const observation = session.observeCommits({
		advance: (publication, frameContext) => {
			for (const change of publication.changes) {
				const list = listAfter(change, id);

				if (list === undefined) continue;

				if (watch === undefined) early = { list, context: frameContext };
				else watch.advance(listCall(list), frameContext);
			}
		},
		end: (end) => {
			if (watch === undefined) ended = end;
			else watch.end(end);
		},
	});

	let list: Readonly<TodoList> | undefined;

	try {
		list = await session.snapshot(ConversationTodos, id, context);
	} catch (error) {
		observation.detach();
		throw error;
	}

	// A throw of the listener ends the watch, and `closed` gives it.
	watch = new Watch<Readonly<TodoList> | null>(
		list ?? null,
		() => observation.detach(),
		() => {},
	);

	if (early !== undefined) watch.advance(listCall(early.list), early.context);

	if (ended !== undefined) watch.end(ended);

	if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);

	return watch;
}

/** The list of the conversation `id` after `change`: `null` when it removed the list, nothing when it is not about it. */
function listAfter(change: CommitChange, id: ConversationId): Readonly<TodoList> | null | undefined {
	if (change.type !== "document" || change.record.kind !== TODO_LIST_KIND || change.conversationId !== id) {
		return undefined;
	}

	// SAFETY: only `ConversationTodos` has the kind `TODO_LIST_KIND`, and its value is a `TodoList`.
	return change.kind === "retire" ? null : (change.value as TodoList);
}

/** The frame of a list watch that replaces its value with `list`. */
function listCall(list: Readonly<TodoList> | null): WatchCall<Readonly<TodoList> | null> {
	return { kind: "value", value: list, ops: [["r", list]], retired: list === null };
}

function refuseEmpty(text: string): void {
	if (text.trim() === "") throw new Error("The text of a todo is empty");
}

function draftOf(tx: Tx, owner: TodoOwner) {
	switch (owner.kind) {
		case "conversation":
			return tx.doc(ConversationTodos, owner.id);
		case "task":
			return tx.doc(TaskTodos, String(owner.id), null);
		case "caller":
			return tx.doc(CallerTodos, owner.caller, null);
	}
}

function snapshotOf(reader: Pick<DocumentReader, "snapshot">, owner: TodoOwner, context: Context) {
	switch (owner.kind) {
		case "conversation":
			return reader.snapshot(ConversationTodos, owner.id, context);
		case "task":
			return reader.snapshot(TaskTodos, String(owner.id), context);
		case "caller":
			return reader.snapshot(CallerTodos, owner.caller, context);
	}
}
