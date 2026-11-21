/**
 * The move of the open todos of the list of the project to work items, at the first start of a host whose store has no
 * counter of the IDs of items: the items, the counter, the moved todos and the labels of the children that served a
 * todo, in one commit. `loadItems` writes the items and the counter.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { moveTodos } from "../protocol/item-move.ts";
import { ItemCounterDoc } from "./item-docs.ts";
import { loadItems } from "./items.ts";
import { OldTodoRecord, relabel } from "./label-migration.ts";
import { ChildRecords } from "./records.ts";
import { ConversationTodos, draftOf } from "./todo-lists.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Moves the todos of the list of the root conversation `root` to items, once: it does nothing when the counter of the
 * IDs of items exists. A child that served a moved todo gets the label `item:<id>` of its item, and a child that served
 * another todo gets no label. The lock of the host keeps other writers out between the check and the commit.
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
		const items = new Set(moved.items.map((item) => item.id));

		for (const record of Object.values((await tx.doc(ChildRecords)).children)) {
			if (!Value.Check(OldTodoRecord, record)) continue;
			const { id } = record.serves;
			relabel(record, items.has(id) ? [`item:${id}`] : []);
		}

		await loadItems(tx, moved.items, moved.last);
	}, context);
}
