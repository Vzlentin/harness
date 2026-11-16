/**
 * The lists of todos in the store: one for each conversation, one for each task that `start` created, and one for each
 * caller that is not a conversation of the host, such as a Pi session. The `todo` request of the host and the tasks of
 * the entries change them with these functions, in their own commits.
 */
import type { Context } from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord/watch";
import type {
	CommitChange,
	ConversationId,
	Cursor,
	DocumentReader,
	Session,
	Storage,
	Tx,
} from "@earendil-works/pi-durable";
import { TODO_LIST_KIND, type Todo, type TodoList, type TodoState } from "../protocol/todo.ts";
import { watchCommits } from "./commit-watch.ts";
import {
	addListTodo,
	type CallerTodoList,
	CallerTodos,
	ConversationTodos,
	draftOf,
	refuseEmpty,
	TaskTodos,
	type TodoOwner,
} from "./todo-lists.ts";

export * from "../protocol/todo.ts";

export type { CallerTodoList, TodoOwner } from "./todo-lists.ts";

/** The number of documents that one page of the scan of the lists of the callers gives. */
const PAGE = 200;

/** Adds a todo with the state `open` to the list of `owner` in `tx`, with the next ID of the list, and gives it. */
export async function addTodo(tx: Tx, owner: TodoOwner, text: string): Promise<Todo> {
	return addListTodo(tx, owner, text);
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
	return { ...todo };
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
	return watchCommits<Readonly<TodoList> | null>(
		session,
		async () => (await session.snapshot(ConversationTodos, id, context)) ?? null,
		(change) => listAfter(change, id),
		context,
	);
}

/**
 * The list of each caller that is not a conversation of the host, in caller order. `storage`, the storage of `reader`,
 * lists the callers, because the session gives no list of the members of a family.
 */
export async function readCallerTodos(
	reader: Pick<DocumentReader, "snapshot">,
	storage: Pick<Storage, "scanDocuments">,
	context: Context,
): Promise<CallerTodoList[]> {
	const { definition } = CallerTodos;
	const callers: string[] = [];
	let cursor: Cursor | undefined;

	do {
		const page = await storage.scanDocuments(
			{ scope: { kind: definition.scope }, at: "current", kind: definition.kind },
			PAGE,
			cursor,
			context,
		);

		for (const record of page.items) {
			if (record.key === undefined) throw new Error(`A list of todos of a caller has no key: ${record.id}`);
			callers.push(record.key);
		}

		cursor = page.next;
	} while (cursor !== undefined);

	return Promise.all(
		callers.sort().map(async (caller) => ({
			caller,
			todos: (await readTodos(reader, { kind: "caller", caller }, context)).todos,
		})),
	);
}

/** Whether `change` can change the list of the conversation `id` or the list of a caller. */
export function todoListChange(change: CommitChange, id: ConversationId): boolean {
	return (
		(change.type === "document" && change.record.kind === CallerTodos.definition.kind) ||
		conversationListChange(change, id)
	);
}

/** Whether `change` is a change of the list of the conversation `id`. */
function conversationListChange(
	change: CommitChange,
	id: ConversationId,
): change is Extract<CommitChange, { type: "document" }> {
	return change.type === "document" && change.record.kind === TODO_LIST_KIND && change.conversationId === id;
}

/** The list of the conversation `id` after `change`: `null` when it removed the list, nothing when it is not about it. */
function listAfter(change: CommitChange, id: ConversationId): Readonly<TodoList> | null | undefined {
	if (!conversationListChange(change, id)) return undefined;

	// SAFETY: only `ConversationTodos` has the kind `TODO_LIST_KIND`, and its value is a `TodoList`.
	return change.kind === "retire" ? null : (change.value as TodoList);
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
