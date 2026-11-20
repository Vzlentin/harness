/**
 * The move of the open todos of the list of the project to work items, at the first start of a host whose store has no
 * counter of the IDs of items: the items, the counter, the moved todos and the records of the children that served a
 * todo, in one commit. `loadItems` writes the items and the counter.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { MIGRATION_CALLER, moveTodos } from "../protocol/item-move.ts";
import { isFinished } from "../protocol/todo.ts";
import { ItemCounterDoc } from "./item-docs.ts";
import { loadItems } from "./items.ts";
import { ChildRecords, type ChildServes, OldTodoServes } from "./records.ts";
import { ConversationTodos, draftOf } from "./todo-lists.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Moves the todos of the list of the root conversation `root` to items, once: it does nothing when the counter of the
 * IDs of items exists. A child that served a moved todo gets the `serves` edge of its item. A child that served a todo
 * that was done or dropped gets the end `due`, so the rule ends it once its own list is clear. A child that served
 * another todo serves an item with no edge. The lock of the host keeps other writers out between the check and the
 * commit.
 */
export async function migrateTodos(harness: Harness, root: ConversationId): Promise<void> {
	if ((await harness.snapshot(ItemCounterDoc, context)) !== undefined) return;
	// A read of a list in a commit creates a missing list, so the commit reads only a list that exists.
	const hasList = (await harness.snapshot(ConversationTodos, root, context)) !== undefined;

	await harness.commit(async (tx) => {
		const at = Date.now();
		const list = hasList ? await draftOf(tx, { kind: "conversation", id: root }) : { todos: [] };
		const finished = new Set(list.todos.flatMap((todo) => (isFinished(todo.state) ? [todo.id] : [])));
		const moved = moveTodos(list.todos, at);
		list.todos = moved.todos;
		const items = new Map(moved.items.map((item) => [item.id, item]));

		for (const record of Object.values((await tx.doc(ChildRecords)).children)) {
			const id = oldTodoId(record.serves);

			if (id === undefined) continue;
			record.serves = { kind: "item" };
			const item = items.get(id);

			if (item !== undefined) {
				item.edges.push({
					from: `agent:${record.conversationId}`,
					kind: "serves",
					to: `item:${id}`,
					at,
					by: MIGRATION_CALLER,
				});
			} else if (finished.has(id) && record.servedEnd === undefined) {
				record.servedEnd = "due";
			}
		}

		await loadItems(tx, moved.items, moved.last);
	}, context);
}

/** The todo ID that a record of version 5 serves, which `ChildServes` does not have, or undefined for another `serves`. */
function oldTodoId(serves: ChildServes | Static<typeof OldTodoServes>): number | undefined {
	return Value.Check(OldTodoServes, serves) ? serves.id : undefined;
}
