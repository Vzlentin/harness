/**
 * A `piDurable` entry with a task named as a workflows run. It opens the session `wf:<runId>/planner`, or one session
 * `wf:<runId>/<label>` for each of `labels` with the label in its record, saves them in the sessions of its root run as
 * workflows does, waits for the file `release` when the input names one, and completes with `result`.
 */
import { existsSync } from "node:fs";
import type { JsonValue } from "@earendil-works/chord";
import type * as Durable from "@earendil-works/pi-durable";
import type { Children, Place } from "../../../src/children.ts";

type RunInput = {
	runId: string;
	name: string;
	cwd: string;
	result: JsonValue;
	release?: string;
	labels?: string[];
	worktree?: { branch: string };
};

export default function runEntry({
	durable,
	children,
	place,
}: {
	readonly durable: typeof Durable;
	readonly children: Children;
	readonly place: Place;
}) {
	const Sessions = durable.defineDocFamily<
		{ sessions: { run: string; conversation: number; task: number; label?: string }[] },
		null
	>({
		kind: "workflows.sessions",
		version: 1,
		scope: "session",
		family: true,
		checkpointWhen: () => false,
		initial: () => ({ sessions: [] }),
	});

	const Run = durable.defineTask<RunInput, { phase: "run" }, JsonValue>({
		name: "workflows.run",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const { input } = task;
				const owner = { kind: "task", taskId: runtime.taskId, conversation: runtime.conversationId } as const;
				const spec = { root: "fixture", provider: "faux", model: "faux-1", cwd: input.cwd };

				for (const label of input.labels ?? [undefined]) {
					const key = `wf:${input.runId}/${label ?? "planner"}`;
					await children.open(place, owner, key, spec, context, async (tx, conversation) => {
						const opened = await tx.doc(Sessions, input.runId, null);
						const session = { run: input.runId, conversation, task: runtime.taskId };
						opened.sessions.push(label === undefined ? session : { ...session, label });
					});
				}

				while (input.release !== undefined && !existsSync(input.release)) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}

				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: input.result } }),
					context,
				);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	return { extensions: [], tasks: [Run], close: async () => {} };
}
