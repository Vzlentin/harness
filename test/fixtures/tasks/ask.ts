/**
 * A `piDurable` entry with a task that asks a child it owns one question and completes with the answer. With `idFile`,
 * the task writes the conversation IDs of its child and its root there as JSON, after it opens the child. `overlay` and
 * `limit` go to the child's spec.
 */
import { writeFile } from "node:fs/promises";
import type * as Durable from "@earendil-works/pi-durable";
import type { Children, Place, Spec } from "../../../src/children.ts";
import type { Overlay } from "../../../src/overlay.ts";

export default function askEntry({
	durable,
	children,
	place,
}: {
	readonly durable: typeof Durable;
	readonly children: Children;
	readonly place: Place;
}) {
	const Ask = durable.defineTask<
		{ cwd: string; prompt: string; agentModel?: boolean; idFile?: string; overlay?: Overlay; limit?: number },
		{ phase: "ask" },
		string
	>({
		name: "fixture.ask",
		version: 1,
		initial: () => ({ phase: "ask" }),
		phases: {
			ask: async (task, runtime, context) => {
				const owner = { kind: "task", taskId: runtime.taskId, conversation: runtime.conversationId } as const;
				const model = task.input.agentModel === true ? {} : { provider: "faux", model: "faux-1" };
				let spec: Spec = { root: "fixture", ...model, cwd: task.input.cwd };

				if (task.input.overlay !== undefined) spec = { ...spec, overlay: task.input.overlay };

				if (task.input.limit !== undefined) spec = { ...spec, limit: task.input.limit };
				const child = await children.open(place, owner, `fixture:${runtime.taskId}`, spec, context);

				if (task.input.idFile !== undefined) {
					const ids = { child: String(child.id), root: String(runtime.conversationId) };
					await writeFile(task.input.idFile, JSON.stringify(ids));
				}

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
