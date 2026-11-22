/**
 * The move of the open todos of the list of the project to work items, at the first start of a host whose store has no
 * counter of the IDs of items: the items, the counter and the moved todos, in one commit. `loadItems` writes the items
 * and the counter.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { ConversationTodos, draftOf } from "../host/todo-lists.ts";
import { moveTodos } from "../protocol/item-move.ts";
import { ItemCounterDoc } from "./item-docs.ts";
import { loadItems } from "./items.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Moves the todos of the list of the root conversation `root` to items, once: it does nothing when the counter of the
 * IDs of items exists. The lock of the host keeps other writers out between the check and the commit.
 */
export async function migrateTodos(harness: Harness, root: ConversationId): Promise<void> {
	if ((await harness.snapshot(ItemCounterDoc, context)) !== undefined) return;
	// A read of a list in a commit creates a missing list, so the commit reads only a list that exists.
	const hasList = (await harness.snapshot(ConversationTodos, root, context)) !== undefined;

	await harness.commit(async (tx) => {
		const at = Date.now();
		const list = hasList ? await draftOf(tx, { kind: "conversation", id: root }) : { todos: [] };
		const moved = moveTodos(list.todos, at);
		list.todos = moved.todos;
		await loadItems(tx, moved.items, moved.last);
	}, context);
}
