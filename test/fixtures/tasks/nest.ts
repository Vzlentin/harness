/**
 * An entry with a task that, in one commit, adds `todo` to its own list of todos and creates a child task of its own
 * kind with `depth - 1` and the todo `<todo> below` when `depth` is above 0, then completes. pi-durable keeps the task
 * `completing` until its child task ends.
 */
import type * as Durable from "@earendil-works/pi-durable";
import { addTodo } from "../../../src/host/todo.ts";

type Input = { depth: number; todo?: string };

type State = { phase: "nest" | "done" };

export default function nestEntry({ durable }: { readonly durable: typeof Durable }) {
	const Nest: Durable.Task<Input, State, null, object> = durable.defineTask<Input, State, null>({
		name: "fixture.nest",
		version: 1,
		initial: () => ({ phase: "nest" }),
		phases: {
			nest: (task, runtime, context) =>
				runtime.commit(async (tx) => {
					const { depth, todo } = task.input;

					if (todo !== undefined) await addTodo(tx, { kind: "task", id: runtime.taskId }, todo);

					if (depth > 0) {
						const below = todo === undefined ? { depth: depth - 1 } : { depth: depth - 1, todo: `${todo} below` };
						await tx.createTask(Nest, below, { ownership: { kind: "task", taskId: runtime.taskId } });
					}

					return { status: "running", checkpoint: { phase: "done" } };
				}, context),
			done: (_task, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	return { extensions: [], tasks: [Nest], close: async () => {} };
}
