/**
 * The lists of todos in the store: one for each conversation, one for each task that `start` created, and one for each
 * caller that is not a conversation of the host, such as a Pi session. The `todo` request of the host and the tasks of
 * the entries change them with these functions, in their own commits.
 */
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, TaskId, Tx } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import type { Todo, TodoList, TodoState } from "../protocol/todo.ts";

export * from "../protocol/todo.ts";

/** Whose list: a conversation, a task, or a caller that is not a conversation of the host. */
export type TodoOwner =
	| { readonly kind: "conversation"; readonly id: ConversationId }
	| { readonly kind: "task"; readonly id: TaskId }
	| { readonly kind: "caller"; readonly caller: string };

/** The list of a conversation. */
const ConversationTodos = durable.defineDoc<TodoList>({
	kind: "harness.todos",
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
	kind: "harness.task-todos",
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
