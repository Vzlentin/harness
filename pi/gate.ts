/**
 * The gate on the tool calls of a Pi session: each call that is not a read goes to the gate of the host first, and a
 * held call waits for the user's answer in a confirm prompt.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { Replies, Request } from "../dist/protocol/index.js";
import type { Harness } from "./index.ts";

/**
 * Registers the gate on the tool calls of the session, whose caller is the session ID and whose request ID is the ID of
 * the call. With a UI, a held call shows its command and its reason: yes approves it and gates the call again, which
 * runs it once; no drops it and refuses the call. Without a UI, a held call is refused with its reason. When the host
 * does not answer, a UI asks one time whether the calls of the session run with no gate: yes lets them run until the
 * host answers again, and no refuses the call. Without a UI, such a call is refused. Each call of a session with no gate
 * sends its `gate` request without a start: when a host answers, the gate is back, with one notification. Another
 * request that fails refuses the call with its error.
 */
export function registerGate(pi: ExtensionAPI, harness: Pick<Harness, "client" | "protocol" | "tool">): void {
	const { client, protocol, tool } = harness;
	/** The sessions whose calls run with no gate until the host answers. */
	const ungated = new Set<string>();
	/** The open question of each session, which the calls at the same time share. */
	const questions = new Map<string, Promise<boolean>>();

	/** Whether the user lets the calls of the session `caller` run with no gate, asked one time for the calls that wait. */
	const askUngated = (caller: string, ui: ExtensionContext["ui"], error: string): Promise<boolean> => {
		const open = questions.get(caller);

		if (open !== undefined) return open;

		const question = ui
			.confirm(
				"The harness host does not answer",
				`${error}\n\nRun the tool calls of this session with no gate until the host answers?`,
			)
			.then((yes) => {
				if (yes) ungated.add(caller);

				return yes;
			})
			.finally(() => questions.delete(caller));

		questions.set(caller, question);

		return question;
	};

	/** Ends the calls with no gate of the session `caller`, and tells the user with a UI. */
	const gateBack = (caller: string, ctx: ExtensionContext): void => {
		if (ungated.delete(caller) && ctx.hasUI) ctx.ui.notify("harness: the host answers again; the gate is back", "info");
	};

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
			const reply = ungated.has(caller)
				? await client.request(gate, { start: false, signal })
				: await tool.sendToHost(gate, signal);

			// No host is running: the session stays with no gate.
			if (reply === undefined) return undefined;
			gateBack(caller, ctx);

			return await gated(harness, gate, reply, ctx, signal);
		} catch (error) {
			const message = protocol.errorMessage(error);

			if (!(error instanceof client.HostUnreachableError)) {
				if (!signal.aborted) gateBack(caller, ctx);

				return refuse(message);
			}

			if (ungated.has(caller)) return undefined;

			if (!ctx.hasUI) {
				return refuse(
					`The harness host does not answer, and this session has no UI to let it run with no gate: ${message}`,
				);
			}

			return (await askUngated(caller, ctx.ui, message)) ? undefined : refuse(message);
		}
	});
}

/**
 * The result of the call of `gate`, from the reply `reply` of the gate. With a UI, a held call waits for the user's
 * answer.
 */
async function gated(
	harness: Pick<Harness, "protocol" | "tool">,
	gate: Extract<Request, { type: "gate" }>,
	reply: Replies["gate"],
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<ToolCallEventResult | undefined> {
	const { protocol, tool } = harness;
	const { caller } = gate;

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
