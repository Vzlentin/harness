/**
 * The `thread`, `rule`, `term` and `part` tools of a Pi session, on the store of the project of the session's host, and
 * the digest of the session before each turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Harness } from "./index.ts";

/**
 * Registers the tools of the store of the project, whose caller is the session ID. Before each turn, the session gets
 * its digest from a host that runs, as a custom message `harness-digest`, when the digest changed since its last one.
 */
export function registerProject(pi: ExtensionAPI, harness: Pick<Harness, "client" | "protocol" | "tool">): void {
	const { client, protocol, tool } = harness;

	tool.projectTools({ Type }, (project) =>
		pi.registerTool({
			name: project.name,
			label: project.label,
			description: project.description,
			parameters: project.parameters,
			outputSchema: project.output,
			// Each call has its own connection, so calls at the same time can reach the host out of order.
			executionMode: "sequential",
			async execute(_toolCallId, args, signal, _onUpdate, ctx) {
				const scope = { caller: ctx.sessionManager.getSessionId(), send: tool.sendToHost, signal };
				const { text, data } = await project.run(args, scope);

				return { content: [{ type: "text", text }], details: undefined, structuredContent: data };
			},
		}),
	);

	// A turn does not start a host: a session with no host gets its digest once a host runs.
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const caller = ctx.sessionManager.getSessionId();
			const reply = await client.request({ type: "digest", caller }, { start: false });

			if (reply?.text === undefined) return undefined;

			return { message: { customType: "harness-digest", content: reply.text, display: true } };
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`harness: no digest: ${protocol.errorMessage(error)}`, "warning");

			return undefined;
		}
	});
}
