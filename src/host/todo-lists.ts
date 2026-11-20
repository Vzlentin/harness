/**
 * The owners and the documents of the lists of todos, and the only writes that add a todo to a list. A todo with an `ask` gets its
 * link in the document `harness.save-todos` in the same call, so a note of the ask finds the list that holds it. The
 * package exports `todo.ts`, not this module, so no entry can write a todo with an `ask`.
 */
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { afterMaxDeltas } from "../children/checkpoint.ts";
import { TASK_TODO_LIST_KIND, TODO_LIST_KIND, type Todo, type TodoList } from "../protocol/todo.ts";

/** Whose list: a conversation, a task, or a caller that is not a conversation of the host. */
export type TodoOwner =
	| { readonly kind: "conversation"; readonly id: ConversationId }
	| { readonly kind: "task"; readonly id: TaskId }
	| { readonly kind: "caller"; readonly caller: string };

/** The list of a caller, with the caller. */
export type CallerTodoList = { caller: string; todos: Todo[] };

/**
 * The list of a conversation. The list of the root conversation lives as long as the store and keeps each todo, so
 * the document stores a base after `MAX_DELTAS` deltas, not at each change.
 */
export const ConversationTodos = durable.defineDoc<TodoList>({
	kind: TODO_LIST_KIND,
	version: 1,
	scope: "conversation",
	history: "latest",
	checkpointWhen: afterMaxDeltas,
	fork: "initial",
	initial: () => ({ todos: [] }),
});

/**
 * The list of a task, by task ID. It is a document of the session, not of the task, so it stays after the commit that
 * makes the task terminal. No commit changes it after that, and the store keeps one list for each task that had a
 * todo, so each change stores a base: the list of one task is small, and the store keeps one revision of it.
 */
export const TaskTodos = durable.defineDocFamily<TodoList, null>({
	kind: TASK_TODO_LIST_KIND,
	version: 1,
	scope: "session",
	checkpointWhen: () => true,
	family: true,
	initial: () => ({ todos: [] }),
});

/**
 * The list of a caller that is not a conversation of the host, by caller. A caller such as a Pi session can keep its
 * list for as long as the store lives, so the document stores a base after `MAX_DELTAS` deltas, not at each change.
 */
export const CallerTodos = durable.defineDocFamily<TodoList, null>({
	kind: "harness.caller-todos",
	version: 1,
	scope: "session",
	checkpointWhen: afterMaxDeltas,
	family: true,
	initial: () => ({ todos: [] }),
});

/** The link of an ask to the owner of the list that holds its todo. */
type Link = { ask: number; owner: TodoOwner };

/**
 * The links of the asks that have a todo. A read of a list in a commit creates a missing list, so this document says
 * which list to read. It gets a link for each ask that has a todo, so it stores a base after `MAX_DELTAS` deltas, not at
 * each change.
 */
const Links = durable.defineDoc<{ links: Link[] }>({
	kind: "harness.save-todos",
	version: 1,
	scope: "session",
	checkpointWhen: afterMaxDeltas,
	initial: () => ({ links: [] }),
});

/**
 * Adds a todo with the state `open` to the list of `owner` in `tx`, with the next ID of the list, and gives it. `ask` is
 * the ID of the ask that the todo belongs to: the same call links the ask to the list.
 */
export async function addListTodo(tx: Tx, owner: TodoOwner, text: string, ask?: number): Promise<Todo> {
	refuseEmpty(text);
	const list = await draftOf(tx, owner);
	const todo: Todo = { id: (list.todos.at(-1)?.id ?? 0) + 1, text, state: "open" };

	if (ask !== undefined) todo.ask = ask;
	await pushTodo(tx, owner, todo);

	return todo;
}

/** The owner of the list that holds the todo of the ask `ask` in `tx`, or nothing when the ask has no todo. */
export async function linkOwner(tx: Tx, ask: number): Promise<TodoOwner | undefined> {
	return (await tx.doc(Links)).links.find((link) => link.ask === ask)?.owner;
}

/**
 * Writes `todos` to the list of the root conversation `root` in `tx`, and the list of each caller of `callerTodos`, also
 * an empty one, into a store whose lists are empty.
 */
export async function loadTodos(
	tx: Tx,
	root: ConversationId,
	todos: readonly Todo[],
	callerTodos: readonly CallerTodoList[],
): Promise<void> {
	await draftOf(tx, { kind: "conversation", id: root });

	for (const todo of todos) await pushTodo(tx, { kind: "conversation", id: root }, todo);

	for (const list of callerTodos) {
		await draftOf(tx, { kind: "caller", caller: list.caller });

		for (const todo of list.todos) await pushTodo(tx, { kind: "caller", caller: list.caller }, todo);
	}
}

export function refuseEmpty(text: string): void {
	if (text.trim() === "") throw new Error("The text of a todo is empty");
}

export function draftOf(tx: Tx, owner: TodoOwner) {
	switch (owner.kind) {
		case "conversation":
			return tx.doc(ConversationTodos, owner.id);
		case "task":
			return tx.doc(TaskTodos, String(owner.id), null);
		case "caller":
			return tx.doc(CallerTodos, owner.caller, null);
	}
}

/** Adds a copy of `todo` to the list of `owner` in `tx`, and the link of its ask to that list when it has one. */
async function pushTodo(tx: Tx, owner: TodoOwner, todo: Todo): Promise<void> {
	(await draftOf(tx, owner)).todos.push({ ...todo });

	if (todo.ask !== undefined) (await tx.doc(Links)).links.push({ ask: todo.ask, owner });
}
