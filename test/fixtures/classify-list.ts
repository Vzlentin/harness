/** An entry that gives the list of `classify-todos`: the todos of `entryTodos`, which a test can change. */
import type { Todo } from "../../src/protocol/todo.ts";

/** The list that the entry gives, in ID order. */
export const entryTodos: Todo[] = [];

export default function classifyListEntry() {
	return { extensions: [], classifyList: async () => entryTodos, close: async () => {} };
}
