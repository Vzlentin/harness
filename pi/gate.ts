/**
 * The gate on the tool calls of a Pi session: each call that is not a read goes to the gate of the host first, and a
 * held call waits for the user's answer in a confirm prompt.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { Request } from "../dist/protocol/index.js";
import type { Harness } from "./index.ts";

/**
 * Registers the gate on the tool calls of the session, whose caller is the session ID and whose request ID is the ID of
 * the call. With a UI, a held call shows its command and its reason: yes approves it and gates the call again, which
 * runs it once; no drops it and refuses the call. Without a UI, a held call is refused with its reason. A request that
 * fails refuses the call with its error.
 */
export function registerGate(pi: ExtensionAPI, harness: Pick<Harness, "protocol" | "tool">): void {
	const { protocol, tool } = harness;

	pi.on("tool_call", async (event, ctx) => {
		if (protocol.asksNoQuestion(event.toolName, event.input)) return undefined;
		const caller = ctx.sessionManager.getSessionId();
		const signal = ctx.signal ?? new AbortController().signal;

		const gate: Extract<Request, { type: "gate" }> = {
			type: "gate",
			requestId: event.toolCallId,
			caller,
			tool: event.toolName,
			arguments: event.input,
			messages: userMessages(ctx, protocol),
		};

		try {
			const reply = await tool.sendToHost(gate, signal);

			if (reply.runs) return undefined;
			const held = reply.held;

			if (!ctx.hasUI || held.state !== "held") return refuse(protocol.heldText(held));

			if (!(await ctx.ui.confirm(`Held action ${held.id}`, `${held.command}\n\n${held.reason}`))) {
				const dropped = await tool.sendToHost({ type: "held", action: "drop", caller, id: held.id }, signal);

				return refuse(protocol.heldText(dropped));
			}

			await tool.sendToHost({ type: "held", action: "approve", caller, id: held.id }, signal);
			const again = await tool.sendToHost(gate, signal);

			return again.runs ? undefined : refuse(protocol.heldText(again.held));
		} catch (error) {
			return refuse(protocol.errorMessage(error));
		}
	});
}

function refuse(reason: string): ToolCallEventResult {
	return { block: true, reason };
}

/** The texts of the last user messages of the branch of the session, at most `GATE_MESSAGES`, oldest first. */
function userMessages(ctx: ExtensionContext, protocol: Harness["protocol"]): string[] {
	return ctx.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []))
		.slice(-protocol.GATE_MESSAGES)
		.map(protocol.userText);
}
