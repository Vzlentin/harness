/**
 * The gate on the tool calls of the agents: the calls that it asks no question about, the command of a call, and the
 * texts of a held action.
 */
import type { UserMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { HeldAction } from "./project.ts";

/** The arguments of a tool call: a JSON object. */
export const ToolArguments = Type.Record(Type.String(), Type.Unknown());

export type ToolArguments = Static<typeof ToolArguments>;

/** The reply of `gate`: the call runs, or the gate holds it as `held`. */
export const GateReply = Type.Union([
	Type.Object({ runs: Type.Literal(true) }),
	Type.Object({ runs: Type.Literal(false), held: HeldAction }),
]);

export type GateReply = Static<typeof GateReply>;

/** The number of the last messages of the user that the gate gives the classifier. */
export const GATE_MESSAGES = 3;

/** The read tools of Pi. */
const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** The tools of the store of the project, whose `list` and `read` actions only read. */
const PROJECT_TOOLS: ReadonlySet<string> = new Set(["thread", "rule", "term", "part"]);

const ReadAction = Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("read")]) });

const BashArguments = Type.Object({ command: Type.String() });

/** Whether the gate lets the call of `tool` with `args` run with no question: a read tool, or a read of the store. */
export function asksNoQuestion(tool: string, args: ToolArguments): boolean {
	return READ_TOOLS.has(tool) || (PROJECT_TOOLS.has(tool) && Value.Check(ReadAction, args));
}

/** The command of the call of `tool` with `args`: the command of a `bash` call, else `<tool> <JSON args>`. */
export function gateCommand(tool: string, args: ToolArguments): string {
	if (tool === "bash" && Value.Check(BashArguments, args)) return args.command;

	return `${tool} ${JSON.stringify(args)}`;
}

/** The text of a call that the gate refuses, for the agent. */
export function heldText(held: HeldAction): string {
	return `Held as action ${held.id}: ${held.reason}`;
}

/** The input that tells the agent of `held` that the user approved it. */
export function approvedText(held: HeldAction): string {
	return `The user approved held action ${held.id}: ${held.command}. Call it again: it runs one time with no question.`;
}

/** The text of the user message `content`: its text parts, joined. */
export function userText(content: UserMessage["content"]): string {
	if (!Array.isArray(content)) return content;

	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
