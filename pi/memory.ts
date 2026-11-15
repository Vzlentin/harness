/**
 * The `memory` tool of a Pi session, and the memory section of its system prompt: the memory of the project agent of
 * the session's host, which runs `~/.optmem/memo` with the memory folder of the project.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Harness } from "./index.ts";

/** The memory snapshot of one session: its session ID, and the text of its section, empty for none. */
type Snapshot = { readonly session: string; readonly text: Promise<string> };

/**
 * Registers the `memory` tool, whose calls go to the host, and the memory section. The first turn of a session takes a
 * snapshot of the memory from the host, which it starts when none runs, and each turn of the session gets that
 * snapshot as the system prompt section `MEMORY_SECTION`. A failed snapshot gives the session no section, and no new
 * request.
 */
export function registerMemory(
	pi: ExtensionAPI,
	harness: Pick<Harness, "client" | "memoryTool" | "protocol" | "tool">,
): void {
	const { client, memoryTool, protocol, tool } = harness;

	memoryTool.memoryTool({ Type }, (memory) =>
		pi.registerTool({
			name: memory.name,
			label: memory.label,
			description: memory.description,
			parameters: memory.parameters,
			async execute(_toolCallId, args, signal) {
				const text = await memory.run(args, { send: tool.sendToHost, signal });

				return { content: [{ type: "text", text }], details: undefined };
			},
		}),
	);

	let snapshot: Snapshot | undefined;

	pi.on("before_agent_start", async (event, ctx) => {
		const session = ctx.sessionManager.getSessionId();

		if (snapshot?.session !== session) {
			const text = client
				.request({ type: "memory", action: "snapshot" }, { start: true })
				.then((reply) => reply.text)
				.catch((cause: unknown) => {
					if (ctx.hasUI) ctx.ui.notify(`harness: no memory: ${protocol.errorMessage(cause)}`, "warning");

					return "";
				});

			snapshot = { session, text };
		}

		const text = await snapshot.text;

		if (text !== "") event.systemPromptOptions.sections[protocol.MEMORY_SECTION] = text;

		return undefined;
	});
}
