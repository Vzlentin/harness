/**
 * The move of the open todos of the list of the project to work items: the first start of a host makes it in its store,
 * and `harness store load` makes it for a store file of version 1.
 */
import type { WorkItem } from "./item.ts";
import { isFinished, type Todo } from "./todo.ts";

/** The caller of the items and the edges that the move writes. */
export const MIGRATION_CALLER = "migration";

/** The list after the move, the new items, and the `last` of the counter of the IDs of items. */
export type MovedTodos = { readonly todos: Todo[]; readonly items: WorkItem[]; readonly last: number };

/**
 * Moves the todos of `todos`, the list of the project, at the time `at`. Each todo that is open or doing and has no ask
 * becomes the open item with its ID and its text as the title, and stays in the list as `dropped`, with the text
 * `moved to item <id>: <text>`. `last` is the highest ID of the list, moved or not, so a new item never takes the ID of
 * an old todo.
 */
export function moveTodos(todos: readonly Todo[], at: number): MovedTodos {
	const items: WorkItem[] = [];

	const moved = todos.map((todo): Todo => {
		if (todo.ask !== undefined || isFinished(todo.state)) return { ...todo };
		items.push({ id: todo.id, title: todo.text, state: "open", edges: [], at, by: MIGRATION_CALLER });

		return { ...todo, state: "dropped", text: `moved to item ${todo.id}: ${todo.text}` };
	});

	return { todos: moved, items, last: Math.max(0, ...todos.map((todo) => todo.id)) };
}
