/**
 * The `thread`, `rule`, `parley` and `item` tools of a Pi session, on the store of the project of the session's host, the
 * digest of the session before each turn, and the section of the decided rules in the system prompt of each turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Harness } from "./index.ts";

/**
 * Registers the tools of the store of the project, whose caller is the session ID. Before each turn, the session gets
 * its digest from a host that runs, as a custom message `harness-digest`, when the digest changed since its last one,
 * and the decided rules of the project as the system prompt section `RULES_SECTION`.
 */
export function registerProject(
	pi: ExtensionAPI,
	harness: Pick<Harness, "client" | "projectTool" | "protocol" | "tool">,
): void {
	const { client, projectTool, protocol, tool } = harness;

	projectTool.projectTools({ Type }, (project) =>
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

	// The digest does not start a host: a session with no host gets its digest once a host runs.
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

	// Pi copies the sections at each turn, so a turn with no host or no decided rule has no section of the rules.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const reply = await client.request({ type: "rule", action: "list", status: "decided" }, { start: false });
			const text = reply !== undefined && "rules" in reply ? protocol.rulesSection(reply.rules) : undefined;

			if (text !== undefined) event.systemPromptOptions.sections[protocol.RULES_SECTION] = text;
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`harness: no rules: ${protocol.errorMessage(error)}`, "warning");
		}

		return undefined;
	});
}
