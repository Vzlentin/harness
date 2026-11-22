/**
 * The move of the open todos of the list of the project to work items, at the first start of a host whose project store
 * has no counter of the IDs of items: the moved todos in one commit, and the items and the counter in one write of the
 * project store in that commit.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { EntryTodos } from "../host/entries.ts";
import { moveTodos } from "../protocol/item-move.ts";
import type { ProjectStore } from "./project-store.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Moves the todos of the list of the root conversation `root` in `todos` to items of `store`, once: it does nothing when
 * the counter of the IDs of items exists. The lock of the host keeps other writers out between the check and the write.
 */
export async function migrateTodos(
	harness: Harness,
	store: Pick<ProjectStore, "lastItem" | "write">,
	todos: EntryTodos,
	root: ConversationId,
): Promise<void> {
	if (store.lastItem() !== undefined) return;
	// A read of a list in a commit creates a missing list, so the commit reads only a list that exists.
	const hasList = await todos.has(harness, root, context);

	await harness.commit(async (tx) => {
		const at = Date.now();
		const list = hasList ? await todos.draft(tx, root) : { todos: [] };
		const moved = moveTodos(list.todos, at);
		list.todos = moved.todos;
		store.write((stx) => stx.loadItems(moved.items, moved.last));
	}, context);
}
