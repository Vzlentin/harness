/** A `piDurable` entry with a task that asks a child it owns one question and completes with the answer. */
import type * as Durable from "@earendil-works/pi-durable";
import type { Children, Place } from "../../../src/children.ts";

export default function askEntry({
	durable,
	children,
	place,
}: {
	readonly durable: typeof Durable;
	readonly children: Children;
	readonly place: Place;
}) {
	const Ask = durable.defineTask<{ cwd: string; prompt: string }, { phase: "ask" }, string>({
		name: "fixture.ask",
		version: 1,
		initial: () => ({ phase: "ask" }),
		phases: {
			ask: async (task, runtime, context) => {
				const owner = { kind: "task", taskId: runtime.taskId, conversation: runtime.conversationId } as const;
				const spec = { root: "fixture", provider: "faux", model: "faux-1", cwd: task.input.cwd };
				const child = await children.open(place, owner, `fixture:${runtime.taskId}`, spec, context);
				const answer = await child.ask({ type: "input", content: task.input.prompt, requestId: "q" }, context);
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome:
							answer.status === "ok"
								? { status: "completed", result: answer.text }
								: { status: "failed", error: { message: answer.reason } },
					}),
					context,
				);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	return { extensions: [], tasks: [Ask], close: async () => {} };
}
