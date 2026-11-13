import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type * as Durable from "@earendil-works/pi-durable";
import type { Agent, Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import type * as TypeBox from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { request } from "./client/client.ts";
import { childLine, isValidRunName, runDisplayName } from "./protocol/labels.ts";
import { CHILD_STATES, ChildKind, type Replies, type Request, THINKING_LEVELS } from "./protocol/requests.ts";
import { AGENT_HANDLE, type ListTarget } from "./protocol/target.ts";
import { TODO_MARKS, TODO_STATES, type Todo, type TodoList, todoLine } from "./protocol/todo.ts";

/** The signal of a call that its adapter cannot abort. */
const NO_ABORT = new AbortController().signal;

/** `words` as one choice in text: `a, b or c`. */
function oneOf(words: readonly string[]): string {
	return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

export const TOOL_DESCRIPTION = `Spawn and manage subagents: separate agents with their own context, for second opinions, independent investigations and delegated work.
When a child finishes, its answer comes to you as a message that starts a turn. Use \`wait\` only when you need the answer in this turn.
- spawn: start a child with \`prompts\` and \`files\`. It uses the model and thinking level of the user's subagent settings, else yours, unless you give others. Give it a short \`name\`. It prints \`Spawned <name> (<handle>)\`. The handle is the short hex ID in parentheses, not the name.
- status, wait, send, rename, stop: act on the child \`handle\`. \`wait\` waits until the child answers its last message (up to \`timeout\` seconds, default 1800) and gives the answer, after the earlier answers of the spawn and the sends that no \`wait\` gave. \`stop\` also stops the children the child spawned. \`send\` steers a busy child, or queues \`message\` with \`followUp\`.
- spawn, send: \`notify: false\` turns off the message for the turns of this call; get the answers with \`wait\`.
- list: your children.
Calls in one message run one after another, in message order, so a \`wait\` after a \`send\` gives the answer to that message.
Children persist after a turn. Stop each child when you no longer need it.
With the \`ipython\` tool, the kernel also has \`rlm\`, a client for the same children: \`print(rlm.__doc__)\` prints its API and its limits.`;

/**
 * The parameters and the output schema of the tool, built with the caller's TypeBox `Type`, so the schemas come from the
 * caller's copy of TypeBox.
 */
export function toolSchemas(typebox: Pick<typeof TypeBox, "Type">) {
	const { Type } = typebox;
	const text = (description: string) => Type.Optional(Type.String({ description }));
	const texts = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));

	const parameters = Type.Object({
		action: Type.Union(
			[
				Type.Literal("spawn"),
				Type.Literal("send"),
				Type.Literal("wait"),
				Type.Literal("status"),
				Type.Literal("rename"),
				Type.Literal("list"),
				Type.Literal("stop"),
			],
			{ description: "What to do" },
		),
		name: text("spawn, rename: the child's name, 1 to 64 characters"),
		provider: text("spawn: the provider; default the subagent setting, else yours"),
		model: text("spawn: the model; default the subagent setting, else yours"),
		thinking: Type.Optional(
			Type.Enum(THINKING_LEVELS, {
				description: `spawn: ${oneOf(THINKING_LEVELS)}; default the subagent setting, else yours`,
			}),
		),
		cwd: text("spawn: the child's working directory; default yours"),
		tools: texts(
			"spawn: the only tools the child gets; default read, grep, find, ls, write, edit, bash, todo, codemode and the package tools",
		),
		prompts: texts("spawn: the task, in parts"),
		files: texts("spawn: files whose text goes before the task"),
		handle: text("send, wait, status, rename, stop: the hex ID that spawn prints in parentheses, not the name"),
		message: text("send: the message"),
		followUp: Type.Optional(Type.Boolean({ description: "send: queue after the current answer, not a steer" })),
		notify: Type.Optional(
			Type.Boolean({ description: "spawn, send: false turns off the message with the answer; default true" }),
		),
		timeout: Type.Optional(Type.Integer({ minimum: 1, description: "wait: seconds; default 1800" })),
		key: text("spawn, send: a key that makes a repeated call do nothing; default the call"),
	});

	const child = Type.Object({
		handle: Type.String(),
		name: Type.Optional(Type.String()),
		state: Type.Enum(CHILD_STATES),
		provider: Type.String(),
		model: Type.String(),
		thinking: Type.String(),
		cwd: Type.String(),
		kind: Type.Optional(Type.Literal(ChildKind.const)),
	});

	const result = <A extends string, V extends TSchema>(action: A, value: V) =>
		Type.Object({ action: Type.Literal(action), value });

	const output = Type.Union([
		result("spawn", child),
		result("send", Type.Object({ verb: Type.String(), child })),
		result("wait", Type.Object({ answer: Type.String() })),
		result("status", child),
		result("rename", child),
		result("list", Type.Array(child)),
		result("stop", Type.Object({ handle: Type.String(), name: Type.Optional(Type.String()) })),
	]);

	return { parameters, output };
}

type Schemas = ReturnType<typeof toolSchemas>;

export type ToolArgs = Static<Schemas["parameters"]>;

/** The result of a call: the text for the model, the same as the CLI output, and the host's reply for programs. */
export type ToolResult = { readonly text: string; readonly data: Static<Schemas["output"]> };

/** Sends one request to the host and gives its reply. */
export type Send = <T extends Request["type"]>(
	request: Extract<Request, { type: T }>,
	signal: AbortSignal,
) => Promise<Replies[T]>;

/** Sends through the host's socket, and starts the host when none runs. */
export const sendToHost: Send = (message, signal) => request(message, { start: true, signal });

/** What a tool call gets from its adapter. */
export type ToolScope = {
	/** The caller that owns the children. */
	readonly caller: string;
	/** The identity of the call. Without `key`, it is the key of a spawn or send. */
	readonly callKey: string;
	/** The caller's own provider, model and thinking level. A spawn uses them when its arguments and the settings give none. */
	readonly provider: string | undefined;
	readonly model: string | undefined;
	readonly thinking: string;
	/** The caller's own working directory. Relative `cwd` and `files` paths resolve against it. A caller without one cannot spawn. */
	readonly cwd: string | undefined;
	readonly send: Send;
	readonly signal: AbortSignal | undefined;
	/** The marker of the children that the call spawns: `rlm` for a call of `rlm` in a kernel. */
	readonly kind?: ChildKind;
};

/** The caller's own provider, model, thinking level and working directory, from its agent. */
export function callerDefaults(
	agent: Pick<Agent, "model" | "thinkingLevel" | "cwd">,
): Pick<ToolScope, "provider" | "model" | "thinking" | "cwd"> {
	return {
		provider: agent.model?.provider,
		model: agent.model?.modelId,
		thinking: agent.thinkingLevel,
		cwd: agent.cwd,
	};
}

/** Runs one call of the tool. */
export async function runTool(args: ToolArgs, scope: ToolScope): Promise<ToolResult> {
	const { action } = args;
	const { send, caller } = scope;
	const signal = scope.signal ?? NO_ABORT;
	const requestId = `${caller}:${args.key ?? scope.callKey}`;
	const handle = () => checkHandle(required(args.handle, "handle", action));

	switch (action) {
		case "spawn": {
			const child = await send(spawnRequest(args, scope, requestId), signal);

			return { text: `Spawned ${runDisplayName(child)}\nState: ${child.state}\n`, data: { action, value: child } };
		}

		case "send": {
			const message = required(args.message?.trim(), "message", action);
			const followUp = args.followUp === true;
			const notify = args.notify !== false;
			const sent = await send({ type: "send", requestId, caller, handle: handle(), message, followUp, notify }, signal);

			return { text: `${sent.verb} ${runDisplayName(sent.child)}\n`, data: { action, value: sent } };
		}

		case "wait": {
			const target = handle();
			const waited = await send({ type: "wait", handle: target, timeout: args.timeout ?? 1800 }, signal);

			return { text: `${target} finished\n\n${waited.answer}\n`, data: { action, value: waited } };
		}

		case "status": {
			const child = await send({ type: "status", handle: handle() }, signal);
			const text = `${runDisplayName(child)}: ${child.state} (${child.provider}/${child.model}, ${child.thinking})\n`;

			return { text, data: { action, value: child } };
		}

		case "rename": {
			const name = normalizeRunName(required(args.name, "name", action));
			const child = await send({ type: "rename", caller, handle: handle(), name }, signal);

			return { text: `Renamed ${runDisplayName(child)}\n`, data: { action, value: child } };
		}

		case "list": {
			const children = await send({ type: "list", caller }, signal);
			const text = children.length === 0 ? "No subagents\n" : children.map((child) => `${childLine(child)}\n`).join("");

			return { text, data: { action, value: [...children] } };
		}

		case "stop": {
			const stopped = await send({ type: "stop", caller, handle: handle() }, signal);

			return { text: `Stopped ${runDisplayName(stopped)}\n`, data: { action, value: stopped } };
		}

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

/** The spawn request of `args`, with the caller's own provider, model, thinking level and working directory from `scope`. */
function spawnRequest(args: ToolArgs, scope: ToolScope, requestId: string): Extract<Request, { type: "spawn" }> {
	const base = scope.cwd;

	if (base === undefined) throw new Error("spawn requires a caller with a working directory");
	const name = args.name === undefined ? undefined : normalizeRunName(args.name);
	const cwd = resolve(base, args.cwd ?? ".");

	if (!existsSync(cwd)) throw new Error(`Working directory not found: ${cwd}`);
	const tools = args.tools?.map((tool) => tool.trim()).filter((tool) => tool);

	if (tools !== undefined && tools.length === 0) throw new Error("tools requires at least one tool name");
	const files = (args.files ?? []).map((file) => resolve(base, file));

	for (const file of files) if (!existsSync(file)) throw new Error(`File not found: ${file}`);
	const prompts = args.prompts ?? [];

	if (prompts.length === 0 && files.length === 0) throw new Error("spawn requires at least one prompt or file");
	// The first message: the text of each file, as Pi gives a file argument to the model, then `Task:` and the prompts.
	let prompt = files.map(fileText).join("");

	if (prompts.length > 0) prompt += `Task:\n${prompts.join("\n\n")}`;

	let request: Extract<Request, { type: "spawn" }> = {
		type: "spawn",
		requestId,
		caller: scope.caller,
		notify: args.notify !== false,
		callerThinking: scope.thinking,
		cwd,
		prompt,
	};

	// The host picks the model: the spawn's, else `subagentModel` in Pi's global settings, else the caller's.
	if (args.provider) request = { ...request, provider: args.provider };

	if (args.model) request = { ...request, model: args.model };

	if (scope.provider) request = { ...request, callerProvider: scope.provider };

	if (scope.model) request = { ...request, callerModel: scope.model };

	if (name !== undefined) request = { ...request, name };

	if (args.thinking !== undefined) request = { ...request, thinking: args.thinking };

	if (tools !== undefined) request = { ...request, tools };

	if (scope.kind !== undefined) request = { ...request, kind: scope.kind };

	return request;
}

/** The text of `file` in a `<file>` block. An empty file gives nothing. */
function fileText(file: string): string {
	if (statSync(file).size === 0) return "";

	return `<file name="${file}">\n${readFileSync(file, "utf8").replace(/^\uFEFF/, "")}\n</file>\n`;
}

function required<T extends string | number>(value: T | undefined, argument: string, action: string): T {
	if (value === undefined || value === "") throw new Error(`${action} requires ${argument}`);

	return value;
}

/** `value` without surrounding spaces. It must be a valid run name. */
function normalizeRunName(value: string): string {
	const name = value.trim();

	if (!isValidRunName(name)) throw new Error("Subagent name must be a single line of 1 to 64 characters");

	return name;
}

function checkHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) throw new Error(`Invalid subagent handle: ${handle}`);

	return handle;
}

/** How a host reaches the harness host. */
export type DurableScope = {
	/** The caller of the calling conversation: it owns the children, and its list of todos is the default list. */
	caller(api: ToolExecutionApi, context: Context): Promise<string>;
	readonly send: Send;
};

/**
 * The pi-durable extension with the `subagent` tool. A call that runs again after a restart has the same task, so its
 * spawn or send has the same request ID and does not repeat.
 */
export function subagentTool(
	durable: typeof Durable,
	typebox: Pick<typeof TypeBox, "Type">,
	scope: DurableScope,
): Extension {
	const { parameters, output } = toolSchemas(typebox);

	const tool = durable.defineTool({
		name: "subagent",
		description: TOOL_DESCRIPTION,
		parameters,
		structuredOutputSchema: output,
		replay: "safe",
		executionMode: "sequential",
		async execute(args, api, context) {
			// pi-durable has validated the arguments, but its types do not narrow TypeBox enums.
			if (!Value.Check(parameters, args)) throw new Error("Invalid subagent arguments");
			const agent = await api.agent(context);

			const { text, data } = await runTool(args, {
				caller: await scope.caller(api, context),
				callKey: String(api.taskId),
				...callerDefaults(agent),
				send: scope.send,
				signal: context.abortSignal,
			});

			return { output: [{ type: "text", text }], structuredOutput: data };
		},
	});

	return durable.defineExtension({ name: "pi-subagent", tools: [tool] });
}

export const TODO_TOOL_DESCRIPTION = `Keep a list of todos: lines of intent, each with an ID and a state.
- add: add a todo with \`text\`. It starts open, with the next ID of the list.
- set: set the \`state\` of the todo \`id\`, and its \`text\` when you give one.
- list: the todos, in ID order.
Each todo prints as \`<mark> <id> <text>\`: ${TODO_STATES.map((state) => `${TODO_MARKS[state]} ${state}`).join(", ")}.
Without \`list\`, the list is your own. \`list: "project"\` is the list of the project, from any place.`;

/** The parameters and the output schema of the todo tool, built with the caller's TypeBox `Type`, as in `toolSchemas`. */
export function todoToolSchemas(typebox: Pick<typeof TypeBox, "Type">) {
	const { Type } = typebox;

	const parameters = Type.Object({
		action: Type.Union([Type.Literal("add"), Type.Literal("set"), Type.Literal("list")], { description: "What to do" }),
		text: Type.Optional(Type.String({ description: "add: the text of the todo; set: its new text" })),
		id: Type.Optional(Type.Integer({ minimum: 1, description: "set: the ID of the todo" })),
		state: Type.Optional(Type.Enum(TODO_STATES, { description: `set: ${oneOf(TODO_STATES)}` })),
		list: Type.Optional(
			Type.Literal("project", { description: "add, set, list: project for the list of the project; default your own" }),
		),
	});

	const todo = Type.Object({
		id: Type.Integer({ minimum: 1 }),
		text: Type.String(),
		state: Type.Enum(TODO_STATES),
	});

	const output = Type.Union([
		Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("set")]), value: todo }),
		Type.Object({ action: Type.Literal("list"), value: Type.Object({ todos: Type.Array(todo) }) }),
	]);

	return { parameters, output };
}

type TodoSchemas = ReturnType<typeof todoToolSchemas>;

export type TodoToolArgs = Static<TodoSchemas["parameters"]>;

/** The result of a call of the todo tool: the output of `harness todo`, and the host's reply. */
export type TodoToolResult = { readonly text: string; readonly data: Static<TodoSchemas["output"]> };

/** The list of a call of the todo tool: the list of the project agent for `list: "project"`, else the caller's own. */
export function todoToolTarget(args: TodoToolArgs): ListTarget {
	return args.list === "project" ? { handle: AGENT_HANDLE } : {};
}

/** Runs one call of the todo tool on the list of `target`. */
export async function runTodoTool(
	args: Omit<TodoToolArgs, "list">,
	scope: Pick<ToolScope, "caller" | "send" | "signal">,
	target: ListTarget,
): Promise<TodoToolResult> {
	const { action } = args;
	const signal = scope.signal ?? NO_ABORT;
	const list = { type: "todo", caller: scope.caller, ...target } as const;

	switch (action) {
		case "add": {
			const todo = replyTodo(await scope.send({ ...list, action, text: required(args.text, "text", action) }, signal));

			return { text: `${todoLine(todo)}\n`, data: { action, value: todo } };
		}

		case "set": {
			const change = {
				...list,
				action,
				id: required(args.id, "id", action),
				state: required(args.state, "state", action),
			};

			const request = args.text === undefined ? change : { ...change, text: args.text };
			const todo = replyTodo(await scope.send(request, signal));

			return { text: `${todoLine(todo)}\n`, data: { action, value: todo } };
		}

		case "list": {
			const todos = replyList(await scope.send({ ...list, action }, signal));
			const text = todos.todos.length === 0 ? "No todos\n" : todos.todos.map((todo) => `${todoLine(todo)}\n`).join("");

			return { text, data: { action, value: todos } };
		}

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

function replyTodo(reply: Replies["todo"]): Todo {
	if ("todos" in reply) throw new Error("The host replied with a list, not a todo");

	return reply;
}

/** The list of the host's reply to a `todo` request with the action `list`. It throws when the reply is a todo. */
export function replyList(reply: Replies["todo"]): TodoList {
	if (!("todos" in reply)) throw new Error("The host replied with a todo, not a list");

	return reply;
}

/**
 * The pi-durable extension with the `todo` tool. The `todo` request has no request ID, so a call that a restart
 * interrupts does not run again: an `add` is never made twice.
 */
export function todoTool(
	durable: typeof Durable,
	typebox: Pick<typeof TypeBox, "Type">,
	scope: DurableScope,
): Extension {
	const { parameters, output } = todoToolSchemas(typebox);

	const tool = durable.defineTool({
		name: "todo",
		description: TODO_TOOL_DESCRIPTION,
		parameters,
		structuredOutputSchema: output,
		replay: "unsafe",
		async execute(args, api, context) {
			// pi-durable has validated the arguments, but its types do not narrow TypeBox enums.
			if (!Value.Check(parameters, args)) throw new Error("Invalid todo arguments");

			const caller = await scope.caller(api, context);
			const signal = context.abortSignal;
			const { text, data } = await runTodoTool(args, { caller, send: scope.send, signal }, todoToolTarget(args));

			return { output: [{ type: "text", text }], structuredOutput: data };
		},
	});

	return durable.defineExtension({ name: "harness-todo", tools: [tool] });
}
