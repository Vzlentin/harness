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
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { TASK_TODO_LIST_KIND, TODO_LIST_KIND, type Todo, type TodoList, type TodoState } from "../protocol/todo.ts";
import { watchCommits } from "./commit-watch.ts";

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

/** The number of documents that one page of the scan of the lists of the callers gives. */
const PAGE = 200;

/** The list of a caller, with the caller. */
export type CallerTodoList = { caller: string; todos: Todo[] };

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
