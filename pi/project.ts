/**
 * The `thread`, `rule`, `term` and `part` tools of a Pi session, on the store of the project of the session's host.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Harness } from "./index.ts";

/** Registers the tools of the store of the project, whose caller is the session ID. */
export function registerProject(pi: ExtensionAPI, harness: Pick<Harness, "tool">): void {
	const { tool } = harness;

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
}
