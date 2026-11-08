/**
 * An entry with an `ipython` tool that follows the contract of pi-ipython. Before the first cell of a conversation,
 * and before the first cell after a `%restart`, it emits `ipython:kernel-starting` with `{ conversationId, env,
 * startupCode, waitFor }` on the host's bus and waits for the `waitFor` promises. It then starts `python3 -I -S
 * kernel.py`, as pi-ipython does, in the agent's working directory with `env`, and runs the startup code, whose failure
 * fails the start.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), "kernel.py");

/** The reply of the kernel to one cell. */
const CellReply = Type.Object({ output: Type.String(), error: Type.Boolean() });

type CellReply = { readonly output: string; readonly error: boolean };

/** One kernel process. A cell that runs when it exits fails. */
class Kernel {
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #pending: { resolve: (reply: CellReply) => void; reject: (error: Error) => void }[] = [];

	constructor(cwd: string, env: Record<string, string>) {
		// -B writes no bytecode next to harness_rlm.py in the checkout.
		this.#process = spawn("python3", ["-B", "-I", "-S", KERNEL], { cwd, env: { ...process.env, ...env } });
		this.#process.stderr.resume();
		createInterface({ input: this.#process.stdout }).on("line", (line) =>
			this.#pending.shift()?.resolve(Value.Parse(CellReply, JSON.parse(line))),
		);
		this.#process.on("exit", () => {
			for (const cell of this.#pending.splice(0)) cell.reject(new Error("The kernel exited"));
		});
	}

	run(code: string): Promise<CellReply> {
		return new Promise((resolve, reject) => {
			this.#pending.push({ resolve, reject });
			this.#process.stdin.write(`${JSON.stringify({ code })}\n`);
		});
	}

	kill(): void {
		this.#process.kill();
	}
}

export default function ipythonEntry({
	durable,
	events,
}: {
	readonly durable: typeof Durable;
	readonly events: EventBus;
}) {
	const kernels = new Map<string, Promise<Kernel>>();

	const startKernel = async (conversationId: ConversationId, cwd: string): Promise<Kernel> => {
		const waits: Promise<void>[] = [];
		const env: Record<string, string> = {};
		const startupCode: string[] = [];
		const waitFor = (promise: Promise<void>) => void waits.push(promise);
		events.emit("ipython:kernel-starting", { conversationId, env, startupCode, waitFor });
		await Promise.all(waits);
		const kernel = new Kernel(cwd, env);

		for (const code of startupCode) {
			const reply = await kernel.run(code);

			if (reply.error) {
				kernel.kill();
				throw new Error(`The startup code failed: ${reply.output}`);
			}
		}

		return kernel;
	};

	const tool = durable.defineTool({
		name: "ipython",
		description: "Runs Python in the kernel of the conversation, with top-level await. The cell %restart stops it.",
		parameters: Type.Object({ code: Type.String() }),
		executionMode: "sequential",
		async execute(args, api, context) {
			const key = String(api.conversationId);
			let kernel = kernels.get(key);

			if (args.code.trim() === "%restart") {
				kernels.delete(key);
				(await kernel?.catch(() => undefined))?.kill();

				return { output: [{ type: "text", text: "Restarted" }] };
			}

			if (kernel === undefined) {
				const { cwd = process.cwd() } = await api.agent(context);
				const started = startKernel(api.conversationId, cwd);
				kernel = started;
				kernels.set(key, started);
				// A failed start runs again at the next cell.
				started.catch(() => kernels.get(key) === started && kernels.delete(key));
			}

			const reply = await (await kernel).run(args.code);

			return { output: [{ type: "text", text: reply.output || "[no output]" }], isError: reply.error };
		},
	});

	return {
		extensions: [durable.defineExtension({ name: "fixture-ipython", tools: [tool] })],
		close: async () => {
			for (const kernel of kernels.values()) (await kernel.catch(() => undefined))?.kill();
			kernels.clear();
		},
	};
}
