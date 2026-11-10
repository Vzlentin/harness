/**
 * An entry with a task that adds each text of its input to its own list of todos, sets the todo 2 to `done`, and
 * completes, all in one commit. The list is in the commit that makes the task terminal, so it stays only when it is not
 * a document of the task.
 */
import type * as Durable from "@earendil-works/pi-durable";
import { addTodo, setTodo } from "../../../src/host/todo.ts";

export default function todoEntry({ durable }: { readonly durable: typeof Durable }) {
	const Write = durable.defineTask<{ texts: string[] }, { phase: "write" }, null>({
		name: "fixture.todo",
		version: 1,
		initial: () => ({ phase: "write" }),
		phases: {
			write: (task, runtime, context) =>
				runtime.commit(async (tx) => {
					const owner = { kind: "task", id: runtime.taskId } as const;

					for (const text of task.input.texts) await addTodo(tx, owner, text);
					await setTodo(tx, owner, { id: 2, state: "done" });

					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context),
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	return { extensions: [], tasks: [Write], close: async () => {} };
}
