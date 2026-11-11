/**
 * An entry whose extension asks, after each run that answered, for a task that waits for `afterRun.gate`. pi-durable
 * keeps the run until that task ends, then deletes the run in a commit that changes only the live document.
 */
import type * as Durable from "@earendil-works/pi-durable";

/**
 * What a test shares with the after-run tasks, which run in its process: the gate that they wait for, and whether one
 * waits for it.
 */
export const afterRun = { gate: Promise.withResolvers<void>(), waiting: false };

export default function afterRunEntry({ durable }: { readonly durable: typeof Durable }) {
	const Wait = durable.defineTask<null, { phase: "wait" }, null>({
		name: "fixture.after-run",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (_task, runtime, context) => {
				afterRun.waiting = true;
				await afterRun.gate.promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	const extension = durable.defineExtension({
		name: "fixture.after-run",
		tasks: [Wait],
		hooks: [durable.hook(durable.GenerationTask, { afterRun: () => ({ tasks: [durable.runEndTask(Wait, null)] }) })],
	});

	return { extensions: [extension], tasks: [], close: async () => {} };
}
