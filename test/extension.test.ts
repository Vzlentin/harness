import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ToolCall,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
	type AgentToolResult,
	type BeforeAgentStartEvent,
	createEventBus,
	type EventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionHandler,
	type ExtensionWidgetOptions,
	type NormalizedBuildSystemPromptOptions,
	type SessionEntry,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type Theme,
	type ToolCallEvent,
	type ToolCallEventResult,
	type WidgetPlacement,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type extension from "../pi/index.ts";
import { request } from "../src/client/client.ts";
import { MIRROR_ENTRY, toMirrorEntry } from "../src/client/mirror.ts";
import type { Host } from "../src/host/run.ts";
import { memoryTool } from "../src/memory-tool.ts";
import { projectTools } from "../src/project-tool.ts";
import { GateReply } from "../src/protocol/gate.ts";
import { onLines } from "../src/protocol/lines.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { Message, Rule } from "../src/protocol/project.ts";
import { MAIN_PROJECT } from "../src/protocol/projects.ts";
import { PROTOCOL_VERSION, versionMismatch } from "../src/protocol/requests.ts";
import { TODO_TOOL_DESCRIPTION, TOOL_DESCRIPTION, todoToolSchemas } from "../src/tool.ts";
import { installMemo, memoCalls, readState, seed } from "./fake-memo.ts";
import {
	calls,
	drawWidget,
	gates,
	models,
	rawReply,
	root,
	setSettings,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	until,
	untilState,
} from "./helpers.ts";

const run = promisify(execFile);
const LoggedMessage = Type.Object({ action: Type.Literal("log"), value: Message });
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAUX = { provider: "faux", model: "faux-1" };

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

/** A registered tool, as a nested call of a cell runs it. */
type Definition = {
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
	readonly outputSchema: object | undefined;
	readonly execute: (
		id: string,
		params: ToolCall["arguments"],
		signal: AbortSignal | undefined,
		ctx: ToolContext,
	) => Promise<AgentToolResult<unknown>>;
};

type ToolContext = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

/** An event of Pi that the tests give to the extension's handlers. */
type PiEvent = SessionStartEvent | SessionShutdownEvent | BeforeAgentStartEvent | ToolCallEvent;

/**
 * An event handler that the extension gives to `pi.on`; the tests call those of `session_start`, `session_shutdown`,
 * `before_agent_start` and `tool_call`.
 */
type Handler = ExtensionHandler<PiEvent, ToolCallEventResult>;

/**
 * A registered tool: its description, its schemas, its execution mode, a call with `args` that gives its text, and the
 * structured contents of its calls, in order.
 */
type Tool = {
	readonly description: string;
	readonly parameters: unknown;
	readonly outputSchema: unknown;
	readonly executionMode: string | undefined;
	readonly call: (args: Args) => Promise<string>;
	readonly structured: unknown[];
};

/** The arguments of a tool call in the tests. */
type Args = Readonly<Record<string, string | number | readonly string[] | readonly number[] | readonly object[]>>;

/** A message that the extension sent to Pi, with its options. */
type Sent = {
	readonly customType: string;
	readonly text: string;
	readonly details: unknown;
	readonly options: unknown;
};

/** A notification that the extension showed in the session. */
type Notification = { readonly message: string; readonly type: string | undefined };

/** The payload of a kernel start, as pi-ipython gives it on `pi.events`. */
type KernelStarting = {
	readonly env: Record<string, string>;
	readonly startupCode: string[];
	readonly waitFor: (promise: Promise<void>) => void;
};

/** What the extension registers in Pi. */
type Registered = {
	readonly tools: Map<string, Tool>;
	/** The tools as the extension registered them, for the nested calls of a cell. */
	readonly definitions: Map<string, Definition>;
	readonly commands: Map<string, Command>;
	readonly shortcuts: string[];
	readonly flags: string[];
	readonly handlers: Map<string, Handler[]>;
	readonly messages: Sent[];
	readonly notifications: Notification[];
	/** The bus of `pi.events`, on which pi-ipython announces its kernel starts. */
	readonly events: EventBus;
};

/**
 * The `node_modules` folder of a fake install of the Pi package: `@vzlentin/pi-agents` from `pi/`, next to its
 * dependency `@vzlentin/harness` built from this checkout, as npm installs them.
 */
let modules: string;
let subagentExtension: typeof extension;
let host: Host | undefined;

/** A fake host of `main`, which a test closes or `afterEach` closes. */
let fake: Server | undefined;

beforeAll(async () => {
	modules = join(realpathSync(await mkdtemp(join(tmpdir(), "harness-extension-"))), "node_modules");
	const harness = join(modules, "@vzlentin", "harness");
	const agents = join(modules, "@vzlentin", "pi-agents");
	const vp = join(repo, "node_modules", "vite-plus", "bin", "vp");
	await run(process.execPath, [vp, "pack", "--out-dir", join(harness, "dist")], { cwd: repo });
	await copyFile(join(repo, "package.json"), join(harness, "package.json"));
	await symlink(join(repo, "node_modules"), join(harness, "node_modules"));
	await mkdir(agents, { recursive: true });

	for (const file of await readdir(join(repo, "pi"))) {
		if (file.endsWith(".ts") || file === "package.json") await copyFile(join(repo, "pi", file), join(agents, file));
	}

	await mkdir(join(harness, "python"));

	for (const file of await readdir(join(repo, "python"))) {
		if (file.endsWith(".py")) await copyFile(join(repo, "python", file), join(harness, "python", file));
	}

	for (const name of ["@earendil-works", "typebox"])
		await symlink(join(repo, "node_modules", name), join(modules, name));
	({ default: subagentExtension } = await import(pathToFileURL(join(agents, "index.ts")).href));
}, 60_000);

afterAll(async () => {
	await rm(dirname(modules), { recursive: true, force: true });
});

beforeEach(async () => {
	await setUp();
	// The `harness` of the user must not be found.
	process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
});

afterEach(async () => {
	await closeFake();
	await host?.close();
	host = undefined;
	await tearDown();
});

/**
 * Starts a fake host of `main` that answers `hello` with the protocol version `version` and the PID 7, and each other
 * request with the error `Invalid request`.
 */
async function startFake(version: number): Promise<void> {
	const { socket } = statePaths(MAIN_PROJECT);
	await mkdir(dirname(socket), { recursive: true });
	fake = createServer((connection: Socket) => {
		onLines(connection, (line) => {
			const reply = line.includes('"type":"hello"')
				? { ok: true, value: { version, pid: 7 } }
				: { ok: false, error: "Invalid request" };

			connection.write(`${JSON.stringify(reply)}\n`);
		});
	});
	await new Promise<void>((resolve) => fake?.listen(socket, resolve));
}

async function closeFake(): Promise<void> {
	const server = fake;
	fake = undefined;

	if (server !== undefined) await new Promise((resolve) => server.close(resolve));
}

/** The context of a tool call: the fields that the tool reads for `list` and `spawn`. */
function toolContext(): ToolContext {
	const ctx = {
		sessionManager: { getSessionId: () => "session", getBranch: (): SessionEntry[] => [] },
		model: undefined,
		cwd: root,
		isProjectTrusted: () => false,
	};

	// SAFETY: the tool reads only these fields of the context for `list` and `spawn`.
	return ctx as ToolContext;
}

/** One assistant entry of a session whose virtual model dispatched to `faux/faux-1` at thinking `medium`. */
const DISPATCHED: SessionEntry = {
	type: "message",
	id: "dispatched",
	parentId: null,
	timestamp: "",
	message: { ...fauxAssistantMessage("Answer of the routed model"), thinkingLevel: "medium" },
};

/** The pi virtual model a session of the tests runs, as pi's catalog entry for one. */
const VIRTUAL: ToolContext["model"] = {
	id: "auto",
	name: "Auto",
	api: "pi-virtual",
	provider: "router",
	baseUrl: "",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	thinkingLevelMap: { off: "off" },
	contextWindow: 0,
	maxTokens: 0,
};

/** A physical model of the tests' catalog, as `ctx.model` gives it. */
const PHYSICAL: ToolContext["model"] = {
	id: "faux-1",
	name: "Faux 1",
	api: "faux",
	provider: "faux",
	baseUrl: "",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	contextWindow: 200_000,
	maxTokens: 8_000,
};

/** The context of a tool call whose session runs `model`, with `entries` as its session branch. */
function modelContext(model: ToolContext["model"], entries: readonly SessionEntry[]): ToolContext {
	const ctx = {
		sessionManager: { getSessionId: () => "session", getBranch: (): SessionEntry[] => [...entries] },
		model,
		cwd: root,
		isProjectTrusted: () => false,
	};

	// SAFETY: the tool reads only these fields of the context for `list` and `spawn`.
	return ctx as ToolContext;
}

/**
 * The context of the call of a cell, as Pi gives it: `toolContext()`, the tools that the extension registered, and
 * `executeTool`, which checks the arguments with pi-ai's validator, as Pi does, then runs the registered tool.
 */
function cellContext(registered: Registered): ToolContext {
	let nested = 0;

	const executeTool = async (
		name: string,
		args: ToolCall["arguments"],
		options?: { readonly signal?: AbortSignal },
	) => {
		const toolCall = { type: "toolCall", id: `cell/${++nested}`, name, arguments: args } as const;

		const tool = registered.definitions.get(name);

		try {
			if (tool === undefined) throw new Error(`Tool ${name} not found`);
			const params = validateToolArguments(tool, toolCall);
			const result = await tool.execute(toolCall.id, params, options?.signal, ctx);

			return { toolCall, result, isError: false };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);

			return { toolCall, result: { content: [{ type: "text", text }], details: {} }, isError: true };
		}
	};

	const ctx: ToolContext = Object.assign(toolContext(), {
		tools: [...registered.definitions.values()],
		executeTool,
	});

	return ctx;
}

/** The text of the parts of a message or of the result of a tool call: its text parts, joined. */
function partsText(parts: readonly { readonly type: string; readonly text?: string }[]): string {
	return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The handle that the text of a spawn gives, or undefined when it gives none. */
function spawnedHandle(text: string): string | undefined {
	return /^Spawned ([a-z0-9]+)$/m.exec(text)?.[1];
}

/** Runs the extension against a fake Pi without flags, and gives what it registers. */
async function load(): Promise<Registered> {
	let calls = 0;

	const registered: Registered = {
		tools: new Map(),
		definitions: new Map(),
		commands: new Map(),
		shortcuts: [],
		flags: [],
		handlers: new Map(),
		messages: [],
		notifications: [],
		events: createEventBus(),
	};

	const api: Pick<
		ExtensionAPI,
		| "events"
		| "registerTool"
		| "registerCommand"
		| "registerShortcut"
		| "registerFlag"
		| "registerEntryRenderer"
		| "on"
		| "getFlag"
		| "getThinkingLevel"
		| "appendEntry"
		| "sendMessage"
	> = {
		events: registered.events,
		registerTool: (tool) => {
			const structured: unknown[] = [];

			const call = async (args: Args) => {
				// SAFETY: the tests give the arguments of the tool's schema.
				const result = await tool.execute(`call-${++calls}`, args as never, undefined, undefined, toolContext());
				structured.push(result.structuredContent);

				return partsText(result.content);
			};

			registered.definitions.set(tool.name, {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				outputSchema: tool.outputSchema,
				// SAFETY: pi-ai's validator checked the arguments against the tool's schema.
				execute: (id, params, signal, ctx) => tool.execute(id, params as never, signal, undefined, ctx),
			});
			registered.tools.set(tool.name, {
				description: tool.description,
				parameters: tool.parameters,
				outputSchema: tool.outputSchema,
				executionMode: tool.executionMode,
				call,
				structured,
			});
		},
		registerCommand: (name, command) => {
			registered.commands.set(name, command);
		},
		registerShortcut: (shortcut) => {
			registered.shortcuts.push(shortcut);
		},
		registerFlag: (name) => {
			registered.flags.push(name);
		},
		registerEntryRenderer: () => {},
		// SAFETY: the tests call only the handlers of the events of `PiEvent`, whose type is `Handler`.
		on: ((event: string, handler: Handler) => {
			registered.handlers.set(event, [...(registered.handlers.get(event) ?? []), handler]);

			return () => {};
		}) as ExtensionAPI["on"],
		getFlag: () => undefined,
		getThinkingLevel: () => "off",
		appendEntry: () => {},
		sendMessage: (message, options) => {
			const text = Array.isArray(message.content) ? partsText(message.content) : message.content;

			registered.messages.push({ customType: message.customType, text, details: message.details, options });
		},
	};

	// SAFETY: the extension calls only these functions while it loads and in the tool and commands of the tests.
	await subagentExtension(api as ExtensionAPI);

	return registered;
}

/** The text that the `subagent` tool gives for `args`. */
async function callTool(registered: Registered, args: Args): Promise<string> {
	const tool = registered.tools.get("subagent");

	if (tool === undefined) throw new Error("no subagent tool");

	return tool.call(args);
}

/** The text that the `subagent` tool gives for `args`, called from the context `ctx`. */
async function callToolAs(registered: Registered, ctx: ToolContext, args: Args): Promise<string> {
	const tool = registered.definitions.get("subagent");

	if (tool === undefined) throw new Error("no subagent tool");

	const params = validateToolArguments(tool, {
		type: "toolCall",
		id: "call",
		name: "subagent",
		// SAFETY: the tests give the arguments of the tool's schema.
		arguments: args as ToolCall["arguments"],
	});

	const result = await tool.execute("call", params, undefined, ctx);

	return partsText(result.content);
}

/**
 * What the extension did with one widget: its placement, its number of sets and of removals, and each render of its
 * component.
 */
type WidgetLog = {
	placement: WidgetPlacement | undefined;
	sets: number;
	removals: number;
	renders: (readonly string[])[];
};

/** The subagents widget and the todo widget. */
type Widgets = { readonly subagents: WidgetLog; readonly todos: WidgetLog };

/** Widgets that the extension did not set yet. */
function noWidgets(): Widgets {
	return {
		subagents: { placement: undefined, sets: 0, removals: 0, renders: [] },
		todos: { placement: undefined, sets: 0, removals: 0, renders: [] },
	};
}

/** The mirror entry of a mirror session of the project agent of `main`. */
const MIRROR = {
	type: "custom",
	customType: MIRROR_ENTRY,
	data: toMirrorEntry({ project: MAIN_PROJECT, target: { kind: "agent" } }),
	id: "mirror-1",
	parentId: null,
	timestamp: "",
} as const;

/**
 * Calls the handlers of `event` with harness, for the session `session` without entries, in `root` with the faux
 * model. Without `widgets`, the session has no UI. With it, the session has a UI whose theme writes `<colour>text`, and
 * `widgets` logs the sets and the removals of the subagents widget and of the todo widget, and each render of their components, at 80
 * columns, when they are set and when they ask for one. With `mirror`, the session is a mirror
 * session of the project agent in Pi's interactive mode, whose components are never drawn. The notifications go to
 * `registered`.
 */
async function sessionEvent(registered: Registered, event: PiEvent, widgets?: Widgets, mirror = false): Promise<void> {
	const ctx: Pick<ExtensionContext, "hasUI" | "cwd" | "mode"> & {
		readonly model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
		readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries" | "getBranch">;
		readonly ui: Pick<ExtensionContext["ui"], "setWidget" | "notify" | "setEditorComponent"> & {
			readonly theme: Pick<Theme, "fg">;
		};
	} = {
		hasUI: widgets !== undefined,
		mode: mirror ? "tui" : "print",
		cwd: root,
		model: { provider: "faux", id: "faux-1" },
		sessionManager: {
			getSessionId: () => "session",
			getEntries: () => [],
			getBranch: () => (mirror ? [MIRROR] : []),
		},
		ui: {
			// The tests do not draw the components of a mirror session.
			setWidget: (
				key: string,
				content: string[] | ((tui: TUI, theme: Theme) => Component) | undefined,
				options?: ExtensionWidgetOptions,
			) => {
				if (widgets === undefined || (key !== "subagents" && key !== "todos")) return;

				const log = widgets[key];

				if (!(content instanceof Function)) {
					if (content !== undefined) throw new Error(`${key} is set with lines`);
					log.removals++;

					return;
				}

				log.sets++;
				log.placement = options?.placement;
				drawWidget(content, ctx.ui.theme, log.renders);
			},
			setEditorComponent: () => {},
			notify: (message, type) => {
				registered.notifications.push({ message, type });
			},
			theme: { fg: (color, text) => `<${color}>${text}` },
		},
	};

	// SAFETY: with harness, the handlers read only these fields of the context, and only the provider and the ID of the
	// model.
	const context = ctx as ExtensionContext;

	for (const handler of registered.handlers.get(event.type) ?? []) await handler(event, context);
}

/**
 * Emits a kernel start on the bus of the extension, as pi-ipython does, and gives its payload once the promises given
 * to `waitFor` settle.
 */
async function kernelStart(registered: Registered): Promise<KernelStarting> {
	const waits: Promise<void>[] = [];
	const starting: KernelStarting = { env: {}, startupCode: [], waitFor: (promise) => void waits.push(promise) };
	registered.events.emit("ipython:kernel-starting", starting);
	// pi-ipython reads the waits right after the emit, so the listener gives its promise before its first `await`.
	expect(waits).toHaveLength(1);
	await Promise.all(waits);

	return starting;
}

/** The sections of the system prompt after the `before_agent_start` handlers, for a session with `selectedTools`. */
async function agentStartSections(registered: Registered, selectedTools: string[]): Promise<Record<string, string>> {
	const sections: Record<string, string> = {};
	// SAFETY: the extension reads only the selected tools and the sections of the options.
	const systemPromptOptions = { selectedTools, sections } as NormalizedBuildSystemPromptOptions;

	await sessionEvent(registered, {
		type: "before_agent_start",
		messageType: "user",
		prompt: "Hello",
		systemPrompt: "",
		systemPromptOptions,
	});

	return sections;
}

/** The result of a `before_agent_start` handler that gives the session a custom message. */
const AgentStartMessage = Type.Object({
	message: Type.Object({ customType: Type.String(), content: Type.String(), display: Type.Boolean() }),
});

/** The custom message that the `before_agent_start` handlers give the session `session` with no UI, if one does. */
async function agentStartMessage(
	registered: Registered,
): Promise<Static<typeof AgentStartMessage>["message"] | undefined> {
	const selectedTools: string[] = [];
	// SAFETY: the extension reads only the selected tools and the sections of the options.
	const systemPromptOptions = { selectedTools, sections: {} } as NormalizedBuildSystemPromptOptions;

	const event = {
		type: "before_agent_start",
		messageType: "user",
		prompt: "Hello",
		systemPrompt: "",
		systemPromptOptions,
	} as const;

	const ctx: Pick<ExtensionContext, "hasUI"> & {
		readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
	} = { hasUI: false, sessionManager: { getSessionId: () => "session" } };

	let message: Static<typeof AgentStartMessage>["message"] | undefined;

	for (const handler of registered.handlers.get("before_agent_start") ?? []) {
		// SAFETY: the handlers of `before_agent_start` read only these fields of the context.
		const result: unknown = await handler(event, ctx as ExtensionContext);

		if (Value.Check(AgentStartMessage, result)) message = result.message;
	}

	return message;
}

/** The start of a kernel of the Pi session: it runs the startup code in its argument, and binds `tools` and `ToolError`. */
const KERNEL_START = [
	"import asyncio, json, sys",
	"namespace = {}",
	"for line in json.loads(sys.argv[1]):",
	"    exec(line, namespace)",
	"tools = namespace['tools']",
	"from harness_tools import ToolError",
];

/**
 * A cell of the Pi session: it spawns a child that notifies and a quiet child that it waits for, adds a todo, and gives
 * a bad argument. It prints the results and the docstring of `tools` as JSON.
 */
const CELL_SCRIPT = [
	...KERNEL_START,
	"async def main():",
	"    loud = await tools.subagent(action='spawn', prompts=['From the Pi kernel'], provider='faux', model='faux-1')",
	"    quiet = await tools.subagent(action='spawn', prompts=['Quiet'], provider='faux', model='faux-1', notify=False)",
	"    waited = await tools.subagent(action='wait', handle=quiet['value']['handle'])",
	"    todo = await tools.todo(action='add', text='From the Pi kernel')",
	"    try:",
	"        await tools.subagent(action='wait', handle='abc123', timeout=0)",
	"        refused = None",
	"    except ToolError as error:",
	"        refused = str(error)",
	"    return dict(loud=loud, quiet=quiet, waited=waited, todo=todo, refused=refused, doc=tools.__doc__)",
	"print(json.dumps(asyncio.run(main())))",
].join("\n");

/** A call of the Pi session after its cell ended: it prints the error of the call. */
const LATE_SCRIPT = [
	...KERNEL_START,
	"try:",
	"    asyncio.run(tools.todo(action='list'))",
	"except ToolError as error:",
	"    print(error)",
].join("\n");

/** The result of a `tool_call` handler that refuses the call. */
const Refused = Type.Object({ block: Type.Literal(true), reason: Type.String() });

/** The states that the classifier of the gate got, in order. */
const gateStates: unknown[] = [];

/** The classifier of the gate: every command writes, and breaks the rule 1. */
async function classifyGate(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	_options?: ClassifierOptions,
): Promise<ClassifierResult> {
	gateStates.push(context.state);

	const result = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: "stop",
	} as const;

	if (context.questions.writes !== undefined) {
		return { ...result, answers: { writes: { type: "bool", probability: 0.9 } } };
	}

	return { ...result, answers: { rule: { type: "choice", choice: "1", probabilities: { 1: 1 }, confidence: 1 } } };
}

/** The classifier model of `gateClassifier` by default, with `classifyGate`. */
function gateClassifier(): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id: "typesafe/jev-1.14",
		name: "Jev",
		api: "test-gate",
		provider: "openrouter",
		baseUrl: "http://gate.test",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
	};
}

/**
 * Calls the `tool_call` handlers of the extension for the call `call`, in the session `session`, whose branch has the
 * user messages `one` to `four`, a custom entry, and three custom messages that the user did not type: the delivered
 * answers of a child and of the user, and a digest. With `answer`, the session has a UI whose confirm
 * prompts go to `prompts` and get `answer`, and whose notifications go to `notes`. It gives the refusal, or nothing
 * when the call runs.
 */
async function toolCall(
	registered: Registered,
	call: { readonly toolName: string; readonly input: Record<string, string>; readonly id: string },
	answer?: boolean,
	prompts: string[] = [],
	notes: string[] = [],
): Promise<Static<typeof Refused> | undefined> {
	type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

	const user = (id: string, content: string | { type: "text"; text: string }[]): Branch[number] => ({
		type: "message",
		id,
		parentId: null,
		timestamp: "",
		message: { role: "user", content, timestamp: 0 },
	});

	const custom = (id: string, customType: string, content: string): Branch[number] => ({
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "",
		customType,
		content,
		display: true,
	});

	const branch: Branch = [
		user("one", "one"),
		user("two", "two"),
		MIRROR,
		user("three", "three"),
		custom("answer", "subagent-answer", "An answer of a child"),
		user("four", [{ type: "text", text: "four" }]),
		custom("user-answer", "user-answer", "An answer of the user to an ask"),
		custom("digest", "harness-digest", "A digest of the store"),
	];

	const ctx: Pick<ExtensionContext, "hasUI" | "signal"> & {
		readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getBranch">;
		readonly ui: Pick<ExtensionContext["ui"], "confirm" | "notify">;
	} = {
		hasUI: answer !== undefined,
		signal: undefined,
		sessionManager: { getSessionId: () => "session", getBranch: () => branch },
		ui: {
			confirm: async (title: string, message: string) => {
				prompts.push(`${title}\n${message}`);

				return answer === true;
			},
			notify: (message: string) => {
				notes.push(message);
			},
		},
	};

	const event = { type: "tool_call", toolCallId: call.id, toolName: call.toolName, input: call.input } as const;
	let result: ToolCallEventResult | undefined;

	for (const handler of registered.handlers.get("tool_call") ?? []) {
		// SAFETY: the gate reads only these fields of the context.
		result = (await handler(event, ctx as ExtensionContext)) ?? result;
	}

	return result === undefined ? undefined : Value.Parse(Refused, result);
}

describe("the Pi extension", () => {
	it("uses its harness dependency without a harness on PATH", async () => {
		host = await startHost();
		const registered = await load();

		expect(registered.tools.get("subagent")?.description).toBe(TOOL_DESCRIPTION);
		expect(await callTool(registered, { action: "list" })).toBe("No subagents\n");
	});

	it("registers /vc and its shortcut", async () => {
		const registered = await load();

		expect(registered.commands.has("vc")).toBe(true);
		expect(registered.shortcuts).toEqual(["ctrl+shift+y"]);
	});

	it("takes for the tool's thinking only pi-ai's levels, in their order", async () => {
		const registered = await load();

		expect(registered.tools.get("subagent")?.parameters).toMatchObject({
			properties: { thinking: { enum: [...MODEL_THINKING_LEVELS] } },
		});
	});

	it("puts the .bin folder next to its harness last on PATH, once for each load", async () => {
		await load();
		await load();
		const bin = join(modules, ".bin");
		const path = (process.env.PATH ?? "").split(delimiter);

		expect(path).toEqual(["/usr/bin", "/bin", bin]);
	});

	it("sends each answer of a child once as a message that starts a turn", async () => {
		host = await startHost();
		const registered = await load();
		await sessionEvent(registered, { type: "session_start", reason: "startup" });

		const first = spawnedHandle(await callTool(registered, { action: "spawn", prompts: ["One"], ...FAUX }));

		await vi.waitFor(() => expect(registered.messages).toHaveLength(1), { timeout: 10_000 });
		expect(registered.messages[0]).toEqual({
			customType: "subagent-answer",
			text: `subagent ${first} finished\n\nAnswer to Task:\nOne`,
			details: { source: "child", handle: first, text: "Answer to Task:\nOne", failed: false },
			options: { triggerTurn: true, deliverAs: "followUp" },
		});

		// A wait after the message gives no answer twice.
		expect(await callTool(registered, { action: "wait", handle: first ?? "" })).toBe(
			`${first} finished\n\nNo new answers: the last answer came as a message.\n`,
		);

		// An answer that a wait gave is not sent again.
		gates.set("Task:\nGated", Promise.withResolvers());

		const gated = spawnedHandle(await callTool(registered, { action: "spawn", prompts: ["Gated"], ...FAUX }));

		const waiting = callTool(registered, { action: "wait", handle: gated ?? "" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		gates.get("Task:\nGated")?.resolve();
		expect(await waiting).toBe(`${gated} finished\n\nAnswer to Task:\nGated\n`);
		await callTool(registered, { action: "spawn", prompts: ["Third"], ...FAUX });
		await vi.waitFor(() => expect(registered.messages).toHaveLength(2), { timeout: 10_000 });
		expect(registered.messages[1]?.text).toContain("Answer to Task:\nThird");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(registered.messages).toHaveLength(2);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" });
	});

	it("spawns a child of a virtual model on the physical model its session dispatched to", async () => {
		host = await startHost();
		const registered = await load();

		const spawned = spawnedHandle(
			await callToolAs(registered, modelContext(VIRTUAL, [DISPATCHED]), {
				action: "spawn",
				prompts: ["Virtual"],
			}),
		);

		expect(await callTool(registered, { action: "status", handle: spawned ?? "" })).toContain("(faux/faux-1, medium)");
	});

	it("spawns a child of a virtual model without a dispatched response on the subagent setting", async () => {
		host = await startHost();
		await setSettings({ subagentModel: "faux/faux-2" });
		const registered = await load();

		const spawned = spawnedHandle(
			await callToolAs(registered, modelContext(VIRTUAL, []), {
				action: "spawn",
				prompts: ["Virtual"],
			}),
		);

		expect(await callTool(registered, { action: "status", handle: spawned ?? "" })).toContain("(faux/faux-2, off)");
	});

	it("refuses a spawn of a virtual model without a dispatched response and without the setting", async () => {
		host = await startHost();
		const registered = await load();

		await expect(
			callToolAs(registered, modelContext(VIRTUAL, []), { action: "spawn", prompts: ["Virtual"] }),
		).rejects.toThrow("No provider specified and the caller has no model");
	});

	it("spawns a child of a session with a physical model on that model", async () => {
		host = await startHost();
		const registered = await load();

		const spawned = spawnedHandle(
			await callToolAs(registered, modelContext(PHYSICAL, []), {
				action: "spawn",
				prompts: ["Physical"],
			}),
		);

		expect(await callTool(registered, { action: "status", handle: spawned ?? "" })).toContain("(faux/faux-1, off)");
	});

	it("sends the answers that came before the session start, and none for mirror input", async () => {
		host = await startHost();
		const registered = await load();

		const spawned = await request(
			{
				type: "spawn",
				requestId: "before-start",
				caller: "session",
				notify: true,
				provider: "faux",
				model: "faux-1",
				callerThinking: "medium",
				cwd: root,
				prompt: "Task:\nBefore start",
			},
			{ start: false },
		);

		await untilState(spawned?.handle ?? "", "idle");
		expect(registered.messages).toEqual([]);
		await sessionEvent(registered, { type: "session_start", reason: "startup" });
		await vi.waitFor(() => expect(registered.messages).toHaveLength(1), { timeout: 10_000 });
		expect(registered.messages[0]?.text).toContain("Answer to Task:\nBefore start");

		const handle = spawned?.handle ?? "";
		const input = { type: "input", requestId: "mirror", handle, message: "From mirror", followUp: false } as const;
		await request(input, { start: false });
		await untilState(handle, "idle");
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" });
		await sessionEvent(registered, { type: "session_start", reason: "startup" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(registered.messages).toHaveLength(1);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" });
	});

	it("sends each answer of the user to an ask of the session as a message that starts a turn", async () => {
		host = await startHost();
		const registered = await load();
		await sessionEvent(registered, { type: "session_start", reason: "startup" });

		const written = await request(
			{ type: "ask", action: "round", caller: "session", asks: [{ title: "Push now?" }] },
			{ start: false },
		);

		if (written === undefined || !("asks" in written)) throw new Error("no host");
		const id = written.asks[0]?.id ?? 0;
		await request(
			{ type: "ask", action: "answer", caller: "user", answers: [{ id, answer: "own", label: "Not yet" }] },
			{ start: false },
		);
		await vi.waitFor(() => expect(registered.messages).toHaveLength(1), { timeout: 10_000 });
		const text = `${id} · Push now? · own · Not yet\n`;

		expect(registered.messages[0]).toEqual({
			customType: "user-answer",
			text: `the user answered ask ${id}\n\n${text}`,
			details: { source: "ask", ask: id, text },
			options: { triggerTurn: true, deliverAs: "followUp" },
		});
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" });
	});

	it("shows the children that are not ended in the widget, and nothing without children or without a host", async () => {
		const registered = await load();
		const quiet = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, quiet);
		await vi.waitFor(() => expect(quiet.subagents.renders).toEqual([[], []]), { timeout: 10_000 });
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, quiet);

		host = await startHost();
		const { handle } = await spawnAs("session", "Task:\nWidget", { notify: false });
		await untilState(handle, "idle");
		const { handle: other } = await spawnAs("session", "Task:\nWidget other", { notify: false });
		await untilState(other, "idle");
		const widgets = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, widgets);
		const lines = [" <dim>subagents", ` <success>${handle}:idle<dim> | <success>${other}:idle`];
		await vi.waitFor(() => expect(widgets.subagents.renders.at(-1)).toEqual(lines), { timeout: 10_000 });
		expect(widgets.subagents).toMatchObject({ placement: "belowEditor", sets: 1 });

		const options: string[][] = [];

		const ctx = {
			sessionManager: { getSessionId: () => "session" },
			ui: {
				select: async (_title: string, items: string[]) => {
					options.push(items);

					return items[1];
				},
				notify: (message: string, type?: string) => {
					registered.notifications.push({ message, type });
				},
			},
		};

		// SAFETY: outside an hc terminal, the handler of `/subagent` reads only these fields of the context.
		await registered.commands.get("subagent")?.handler("", ctx as Parameters<Command["handler"]>[1]);
		expect(options).toEqual([[`${handle}  idle      faux/faux-1  medium`, `${other}  idle      faux/faux-1  medium`]]);
		expect(registered.notifications).toEqual([
			{ message: `Run in another terminal: harness attach ${other}`, type: "info" },
		]);
		// An ended child stays in the list, and the widget leaves it out.
		await request({ type: "stop", caller: "session", handle: other }, { start: false });
		const live = [" <dim>subagents", ` <success>${handle}:idle`];
		await vi.waitFor(() => expect(widgets.subagents.renders.at(-1)).toEqual(live), { timeout: 10_000 });
		// SAFETY: as above, the handler reads only these fields of the context.
		await registered.commands.get("subagent")?.handler("", ctx as Parameters<Command["handler"]>[1]);
		expect(options.at(-1)).toEqual([
			`${handle}  idle      faux/faux-1  medium`,
			`${other}  ended     faux/faux-1  medium`,
		]);
		await host?.close();
		host = undefined;
		await vi.waitFor(() => expect(widgets.subagents.renders.at(-1)).toEqual([]), { timeout: 10_000 });
		expect(widgets.subagents.sets).toBe(1);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, widgets);
		expect(widgets.subagents).toMatchObject({ sets: 1, removals: 1 });
	});

	it("serves the tools of each cell of the session to its kernel, and closes its server at the session end", async () => {
		host = await startHost();
		const registered = await load();
		await sessionEvent(registered, { type: "session_start", reason: "startup" });

		registered.events.emit("ipython:kernel-starting", { env: {}, startupCode: [] });
		registered.events.emit("ipython:cell-start", { toolCallId: "cell-0" });
		expect(registered.notifications).toEqual([
			{
				message: "The ipython:kernel-starting event has an invalid payload; its kernel gets no tools",
				type: "warning",
			},
			{ message: "The ipython:cell-start event has an invalid payload; its cell gets no tools", type: "warning" },
		]);

		const { env, startupCode } = await kernelStart(registered);
		const socket = env.HARNESS_TOOLS_SOCKET ?? "";
		expect(socket).toMatch(/^\/tmp\/harness-tools-[^/]+\/kernel\.sock$/);
		expect(env.HARNESS_TOOLS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
		expect(process.env.HARNESS_TOOLS_SOCKET).toBeUndefined();
		expect(process.env.HARNESS_TOOLS_TOKEN).toBeUndefined();

		const python = async (script: string) =>
			(
				await run("python3", ["-I", "-B", "-c", script, JSON.stringify(startupCode)], {
					env: { ...process.env, ...env },
					timeout: 30_000,
				})
			).stdout;

		registered.events.emit("ipython:cell-start", { toolCallId: "cell-1", ctx: cellContext(registered) });
		const cell = JSON.parse(await python(CELL_SCRIPT));
		registered.events.emit("ipython:cell-end", { toolCallId: "cell-1" });

		expect(cell.loud).toMatchObject({ action: "spawn", value: { ...FAUX, cwd: root } });
		expect(cell.waited).toEqual({ action: "wait", value: { answer: "Answer to Task:\nQuiet" } });
		expect(cell.todo).toEqual({ action: "add", value: { id: 1, text: "From the Pi kernel", state: "open" } });
		expect(cell.refused).toMatch(/^Validation failed for tool "subagent":\n {2}- timeout: /);
		expect(cell.doc).toContain("\n- subagent: Spawn and manage subagents");
		expect(cell.doc).not.toContain("\n- ipython:");

		// The children of the cell are those of the session's tool, and only the child without notify: false notifies.
		const listed = await callTool(registered, { action: "list" });
		expect(listed).toContain(cell.loud.value.handle);
		expect(listed).toContain(cell.quiet.value.handle);
		await vi.waitFor(() => expect(registered.messages).toHaveLength(1), { timeout: 10_000 });
		expect(registered.messages[0]?.text).toBe(
			`subagent ${cell.loud.value.handle} finished\n\nAnswer to Task:\nFrom the Pi kernel`,
		);

		// After the end of its cell, a call raises.
		expect(await python(LATE_SCRIPT)).toBe("No cell of this kernel runs: tools runs a tool only while a cell runs\n");

		// A new kernel start replaces the server.
		const restarted = (await kernelStart(registered)).env.HARNESS_TOOLS_SOCKET ?? "";
		expect(restarted).toMatch(/^\/tmp\/harness-tools-[^/]+\/kernel\.sock$/);
		expect(restarted).not.toBe(socket);
		expect(existsSync(dirname(socket))).toBe(false);

		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" });
		await expect(rawReply(restarted, "{}")).rejects.toThrow("ENOENT");
		expect(existsSync(dirname(restarted))).toBe(false);
	});

	it("gives the todo tool of the host, on the list of the session only, with the whole list after each call", async () => {
		host = await startHost();
		const registered = await load();
		const todo = registered.tools.get("todo");
		const { parameters, output } = todoToolSchemas({ Type });

		expect(todo).toMatchObject({
			description: TODO_TOOL_DESCRIPTION,
			parameters,
			outputSchema: output,
			executionMode: "sequential",
		});
		expect(Object.keys(parameters.properties)).toEqual(["action", "text", "id", "state"]);
		await request({ type: "todo", caller: "session", action: "add", text: "Save to the vault" }, { start: false });
		expect(await todo?.call({ action: "add", text: "Write the plan" })).toBe(
			"○ 1 Save to the vault\n○ 2 Write the plan\n",
		);
		expect(await todo?.call({ action: "set", id: 2, state: "doing" })).toBe(
			"○ 1 Save to the vault\n◉ 2 Write the plan\n",
		);
		expect(todo?.structured).toEqual([
			{ action: "add", value: { id: 2, text: "Write the plan", state: "open" } },
			{ action: "set", value: { id: 2, text: "Write the plan", state: "doing" } },
		]);

		const own = await request({ type: "todo", caller: "session", action: "list" }, { start: false });
		expect(own).toEqual({
			todos: [
				{ id: 1, text: "Save to the vault", state: "open" },
				{ id: 2, text: "Write the plan", state: "doing" },
			],
		});
		const project = await request({ type: "todo", caller: "cli", action: "list", handle: "agent" }, { start: false });
		expect(project).toEqual({ todos: [] });
	});

	it("adds a session todo with /todo, from its arguments or an input, refreshes the widget, and refuses in a mirror session", async () => {
		host = await startHost();
		const registered = await load();
		const widgets = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, widgets);
		await vi.waitFor(() => expect(widgets.todos.renders).toEqual([[], []]), { timeout: 10_000 });
		const command = registered.commands.get("todo");
		const inputs = ["From the input", undefined, "", "   "];
		let branch: SessionEntry[] = [];

		const ctx: Pick<ExtensionCommandContext, "hasUI"> & {
			readonly sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getBranch" | "getSessionId">;
			readonly ui: Pick<ExtensionCommandContext["ui"], "input" | "notify">;
		} = {
			hasUI: true,
			sessionManager: { getBranch: () => branch, getSessionId: () => "session" },
			ui: {
				input: async () => inputs.shift(),
				notify: (message: string, type?: "info" | "warning" | "error") => {
					registered.notifications.push({ message, type });
				},
			},
		};

		expect(command?.description).toBe("Add a todo to this session's list");
		// SAFETY: the handler of `/todo` reads only these fields of the context.
		const commandCtx = ctx as Parameters<Command["handler"]>[1];
		await command?.handler("From the arguments", commandCtx);
		expect(widgets.todos.renders.at(-1)).toEqual([" <dim>todos 0/1", " ○ 1 From the arguments"]);
		await command?.handler("", commandCtx);
		// A cancel, an empty answer and an answer of spaces add nothing and show nothing.
		await command?.handler("", commandCtx);
		await command?.handler("", commandCtx);
		await command?.handler(" ", commandCtx);
		expect(inputs).toEqual([]);
		// A mirror session shows the list of the mirrored agent, so /todo refuses.
		branch = [MIRROR];
		await command?.handler("In a mirror", commandCtx);

		expect(registered.notifications).toEqual([
			{ message: "○ 1 From the arguments", type: "info" },
			{ message: "○ 2 From the input", type: "info" },
			{ message: "harness: /todo does not work in a mirror session", type: "error" },
		]);
		expect(await request({ type: "todo", caller: "session", action: "list" }, { start: false })).toEqual({
			todos: [
				{ id: 1, text: "From the arguments", state: "open" },
				{ id: 2, text: "From the input", state: "open" },
			],
		});
		expect(widgets.todos.renders.at(-1)).toEqual([" <dim>todos 0/2", " ○ 1 From the arguments", " ○ 2 From the input"]);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, widgets);
	});

	it("gives the thread, rule, parley and item tools of the host, on the store of the project", async () => {
		host = await startHost();
		const registered = await load();

		const expected = projectTools({ Type }, (tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			outputSchema: tool.output,
			executionMode: "sequential",
		}));

		for (const { name, ...tool } of expected) expect(registered.tools.get(name)).toMatchObject(tool);
		expect(expected.map((tool) => tool.name)).toEqual(["thread", "rule", "parley", "item"]);
		expect(registered.tools.has("term")).toBe(false);
		expect(registered.tools.has("part")).toBe(false);

		const person = await request({ type: "person", action: "add", name: "Sam" }, { start: false });
		const thread = await request({ type: "thread", action: "add", topic: "Pi", persons: [1] }, { start: false });

		if (person === undefined || thread === undefined || !("id" in thread)) throw new Error("no host");
		const tools = registered.tools;
		const at = Date.UTC(2026, 10, 12);
		const logged = await tools.get("thread")?.call({ action: "log", thread: thread.id, from: 1, at, text: "Hello" });
		const source = Value.Parse(LoggedMessage, tools.get("thread")?.structured[0]).value.id;
		expect(logged).toBe(`${source} 2026-11-12T00:00:00.000Z Sam (1) (received): Hello\n`);
		const rule = { action: "set", name: "hello", kind: "conduct", value: "Say hello.", saidBy: 1, source };

		expect(await tools.get("rule")?.call(rule)).toBe(
			`1 hello (conduct, open): Say hello. [said by Sam (1) in message ${source}]\n`,
		);
		await expect(tools.get("rule")?.call({ action: "set", id: 1, value: "Say hi.", saidBy: 1 })).rejects.toThrow(
			"set requires source",
		);

		const asks = [
			{ title: "Where", kind: "your call", options: [{ key: "a", label: "Here" }], plan: "a", view: "Here" },
		];

		expect(await tools.get("parley")?.call({ action: "round", slug: "pi", title: "Pi asks", goal: "Ask.", asks })).toBe(
			"pi · open · Pi asks\n1 · Where · your call · open · plan a · Here\n  a · Here\n[pi] 1a\n",
		);
		expect(await tools.get("parley")?.call({ action: "read", slug: "pi", ask: 1 })).toBe(
			"1 · Where · your call · open · plan a · Here\nHere\n",
		);
		await expect(tools.get("parley")?.call({ action: "end", slug: "pi", status: "done" })).rejects.toThrow(
			"Parley pi is open",
		);
		// The asker records the vault note of an ask, by its number in its parley or by its ID.
		expect(await tools.get("parley")?.call({ action: "note", slug: "pi", ask: 1, note: "20261115-pi" })).toBe(
			"1 · Where · your call · open · plan a · Here\n",
		);
		expect(tools.get("parley")?.structured.at(-1)).toMatchObject({
			action: "note",
			value: { note: "20261115-pi", asker: "session", by: "session", parley: { n: 1 } },
		});
		// A round with item writes the edge shapes from its parley; item needs slug.
		const item = await request({ type: "item", action: "add", caller: "cli", title: "Pi" }, { start: false });

		if (item === undefined || !("id" in item)) throw new Error("no item");
		await tools.get("parley")?.call({ action: "round", slug: "pi", item: item.id, asks: [{ title: "More" }] });
		expect(await request({ type: "item", action: "read", id: item.id }, { start: false })).toMatchObject({
			edges: [{ from: "parley:pi", kind: "shapes", to: `item:${item.id}`, by: "session" }],
		});
		await expect(
			tools.get("parley")?.call({ action: "round", item: item.id, asks: [{ title: "Lost" }] }),
		).rejects.toThrow("round requires slug");
		const lone = await tools.get("parley")?.call({ action: "round", asks: [{ title: "Alone" }] });
		const loneId = Number(lone?.split(" ")[0]);
		expect(await tools.get("parley")?.call({ action: "note", ask: loneId, note: "alone" })).toBe(
			`${loneId} · Alone · open\n`,
		);
		expect(tools.get("parley")?.structured.at(-1)).toMatchObject({
			action: "note",
			value: { id: loneId, note: "alone" },
		});
		await expect(tools.get("parley")?.call({ action: "note", slug: "pi", note: "n" })).rejects.toThrow(
			"note requires ask",
		);
		await expect(tools.get("parley")?.call({ action: "note", ask: loneId })).rejects.toThrow("note requires note");
		await expect(tools.get("parley")?.call({ action: "note", ask: loneId, note: "  " })).rejects.toThrow(
			'Invalid ask request: note: must match pattern "\\S"',
		);
		expect(await request({ type: "ask", action: "read", id: loneId }, { start: false })).toMatchObject({
			note: "alone",
		});
		// The item tool gives the text of each action, and its reply as the structured result.
		const items = tools.get("item");
		const added = await items?.call({ action: "add", title: "Ship Pi", text: "All of it." });
		const id = Number(added?.split(" ")[1]);
		expect(added).toBe(`○ ${id} inbox Ship Pi\n`);
		expect(await items?.call({ action: "set", id, title: "Ship the Pi side" })).toBe(
			`○ ${id} inbox Ship the Pi side\n`,
		);
		const run = "run:20261120T172928-841433af";
		expect(await items?.call({ action: "link", from: run, kind: "serves", to: `item:${id}` })).toBe(
			`${run} serves item:${id}\n`,
		);
		expect(await items?.call({ action: "read", id })).toBe(
			`○ ${id} inbox Ship the Pi side\nAll of it.\n${run} serves item:${id}\n`,
		);
		expect(await items?.call({ action: "list" })).toContain(`○ ${id} inbox Ship the Pi side\n`);
		expect(await items?.call({ action: "set", id, state: "dropped" })).toBe(`✗ ${id} dropped Ship the Pi side\n`);
		expect(await items?.call({ action: "list", state: "dropped" })).toBe(`✗ ${id} dropped Ship the Pi side\n`);
		expect(
			items?.structured.map((result) => Value.Parse(Type.Object({ action: Type.String() }), result).action),
		).toEqual(["add", "set", "link", "read", "list", "set", "list"]);
		expect(items?.structured[2]).toEqual({
			action: "link",
			value: { from: run, kind: "serves", to: `item:${id}`, at: expect.any(Number), by: "session" },
		});
		expect(items?.structured.at(-1)).toMatchObject({
			action: "list",
			value: { items: [{ id, state: "dropped", stage: "dropped", needsYou: false, by: "session" }] },
		});
		await expect(items?.call({ action: "link", from: "nope", kind: "serves", to: `item:${id}` })).rejects.toThrow(
			"Invalid item reference: nope",
		);

		// The answers of the parley tool are the answers of the agent of the session.
		await tools.get("parley")?.call({ action: "answer", slug: "pi", answers: [{ ask: 1, answer: "a" }] });
		expect(await request({ type: "ask", action: "read", slug: "pi", n: 1 }, { start: false })).toMatchObject({
			state: "answered",
			by: "session",
			author: { kind: "agent", caller: "session" },
		});
		expect(await tools.get("thread")?.call({ action: "read", thread: thread.id })).toBe(
			`${thread.id} Pi with Sam (1): last message 2026-11-12T00:00:00.000Z\n${source} 2026-11-12T00:00:00.000Z Sam (1) (received): Hello\n`,
		);
		// The host keeps the session ID as the caller of each write.
		expect(await request({ type: "rule", action: "list" }, { start: false })).toMatchObject({
			rules: [{ id: 1, name: "hello", saidBy: 1, source, by: "session" }],
		});
		expect(await request({ type: "thread", action: "read", id: thread.id }, { start: false })).toMatchObject({
			thread: { last: at },
			messages: [{ id: source, text: "Hello", by: "session" }],
		});

		// Before a turn, the session gets its digest when it changed, and a mark of the draft changes it.
		expect(await agentStartMessage(registered)).toBeUndefined();
		await tools.get("thread")?.call({ action: "draft", thread: thread.id, text: "Hi Sam" });
		const draft = Value.Parse(Type.Object({ value: Message }), tools.get("thread")?.structured.at(-1)).value;
		expect(await agentStartMessage(registered)).toEqual({
			customType: "harness-digest",
			content: "waiting on: Sam (Pi, draft not sent)\nheld: none",
			display: true,
		});
		expect(await agentStartMessage(registered)).toBeUndefined();
		expect(await tools.get("thread")?.call({ action: "mark", message: draft.id, state: "dropped" })).toMatch(
			new RegExp(`^${draft.id} \\S+ user \\(dropped\\): Hi Sam\n$`),
		);
		await expect(tools.get("thread")?.call({ action: "mark", message: draft.id })).rejects.toThrow(
			"mark requires state",
		);
		expect(await agentStartMessage(registered)).toMatchObject({ content: "waiting on: none\nheld: none" });
	});

	it("lists the rules with /rules, open first, and makes the change that the user picks, or with no UI only prints them", async () => {
		host = await startHost();
		const registered = await load();
		const create = { type: "rule", action: "create", caller: "cli", kind: "domain" } as const;
		await request({ ...create, name: "done", value: "Done." }, { start: false });
		await request({ ...create, name: "gone", value: "Gone." }, { start: false });
		await request({ type: "rule", action: "retire", caller: "cli", id: 2 }, { start: false });
		await request({ type: "person", action: "add", name: "Sam" }, { start: false });
		const thread = await request({ type: "thread", action: "add", topic: "Rules", persons: [1] }, { start: false });
		const log = { type: "message", action: "log", caller: "cli", from: 1, direction: "in", text: "Hi" } as const;

		if (thread === undefined || !("id" in thread)) throw new Error("no host");
		const said = await request({ ...log, thread: thread.id }, { start: false });
		const set = { type: "rule", action: "set", caller: "cli", saidBy: 1, source: said?.id ?? 0 } as const;
		await request({ ...set, name: "ask", kind: "conduct", value: "Ask first." }, { start: false });

		const lines = [
			`3 ask (conduct, open): Ask first. [said by Sam (1) in message ${said?.id}]`,
			"1 done (domain, decided): Done. [said by user]",
			"2 gone (domain, retired): Gone. [said by user]",
		];

		const written: unknown[][] = [];
		const write = vi.spyOn(process.stdout, "write").mockImplementation((...args) => written.push(args) > 0);
		const quiet = { hasUI: false, sessionManager: { getSessionId: () => "session" }, ui: {} };

		try {
			// SAFETY: with no UI, the handler of `/rules` reads only these fields of the context.
			await registered.commands.get("rules")?.handler("", quiet as Parameters<Command["handler"]>[1]);
		} finally {
			write.mockRestore();
		}

		expect(written).toEqual([[lines.map((line) => `${line}\n`).join("")]]);
		expect(await request({ type: "rule", action: "list", status: "open" }, { start: false })).toMatchObject({
			rules: [{ id: 3 }],
		});

		const options: string[][] = [];

		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "session" },
			ui: {
				select: async (_title: string, items: string[]) => {
					options.push(items);

					return items.includes("Decide") ? "Decide" : lines[0];
				},
				notify: (message: string, type?: string) => {
					registered.notifications.push({ message, type });
				},
			},
		};

		// SAFETY: for a decide, the handler of `/rules` reads only these fields of the context.
		await registered.commands.get("rules")?.handler("", ctx as Parameters<Command["handler"]>[1]);
		expect(options).toEqual([
			["New rule", ...lines],
			["Decide", "Retire", "Edit", "Delete"],
		]);
		const decided = `3 ask (conduct, decided): Ask first. [said by Sam (1) in message ${said?.id}]`;
		expect(registered.notifications).toEqual([{ message: decided, type: "info" }]);
		expect(await request({ type: "rule", action: "list", status: "decided" }, { start: false })).toMatchObject({
			rules: [{ id: 1 }, { id: 3, by: "session" }],
		});
	});

	it("shows the todos of the session while one is open or doing, at once after a call, only on a change, and nothing without a host", async () => {
		const registered = await load();
		const quiet = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, quiet);
		await vi.waitFor(() => expect(quiet.todos.renders).toEqual([[], []]), { timeout: 10_000 });
		expect(existsSync(statePaths(MAIN_PROJECT).socket)).toBe(false);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, quiet);

		host = await startHost();
		const todo = registered.tools.get("todo");
		const widgets = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, widgets);
		await vi.waitFor(() => expect(widgets.todos.renders).toEqual([[], []]), { timeout: 10_000 });
		await todo?.call({ action: "add", text: "Write the plan" });
		expect(widgets.todos.renders.at(-1)).toEqual([" <dim>todos 0/1", " ○ 1 Write the plan"]);
		await todo?.call({ action: "add", text: "Ship it" });
		await todo?.call({ action: "set", id: 1, state: "done" });
		await todo?.call({ action: "set", id: 2, state: "doing" });
		expect(widgets.todos.renders.at(-1)).toEqual([" <dim>todos 1/2", " ◉ 2 Ship it"]);

		// A tick with the same lines does not draw again.
		const shown = widgets.todos.renders.length;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(widgets.todos.renders).toHaveLength(shown);
		await todo?.call({ action: "set", id: 2, state: "done" });
		expect(widgets.todos.renders.at(-1)).toEqual([]);
		// Pi moves a widget that is set again, so each change only draws the widget that was set at the start.
		expect(widgets.todos).toMatchObject({ placement: "aboveEditor", sets: 1, removals: 0 });
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, widgets);
		expect(widgets.todos).toMatchObject({ sets: 1, removals: 1 });
	});

	it("does not show the todos of the local session in a mirror session", async () => {
		host = await startHost();
		await request({ type: "todo", caller: "session", action: "add", text: "Local" }, { start: false });
		const registered = await load();
		const widgets = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, widgets, true);
		await vi.waitFor(() => expect(widgets.subagents.renders).toEqual([[], []]), { timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(widgets.todos.sets).toBe(1);
		expect(widgets.todos.renders.every((lines) => lines.length === 0)).toBe(true);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, widgets, true);
		expect(widgets.todos).toMatchObject({ sets: 1, removals: 1 });
		expect(widgets.subagents).toMatchObject({ sets: 1, removals: 1 });
	});

	it("gives the session the decided rules of the project as a section, and none with no decided rule or a failed list", async () => {
		host = await startHost();
		const registered = await load();
		const create = { type: "rule", action: "create", caller: "cli", kind: "domain" } as const;
		await request({ ...create, name: "gone", value: "Gone." }, { start: false });
		await request({ type: "rule", action: "retire", caller: "cli", id: 1 }, { start: false });
		await request({ type: "person", action: "add", name: "Sam" }, { start: false });
		const thread = await request({ type: "thread", action: "add", topic: "Rules", persons: [1] }, { start: false });
		const log = { type: "message", action: "log", caller: "cli", from: 1, direction: "in", text: "Hi" } as const;

		if (thread === undefined || !("id" in thread)) throw new Error("no host");
		const said = await request({ ...log, thread: thread.id }, { start: false });
		const set = { type: "rule", action: "set", caller: "cli", saidBy: 1, source: said?.id ?? 0 } as const;
		await request({ ...set, name: "open", kind: "domain", value: "Not yet." }, { start: false });

		expect(await agentStartSections(registered, ["read"])).toEqual({});

		await request({ ...create, name: "done", value: "Done." }, { start: false });

		expect(await agentStartSections(registered, ["read"])).toEqual({
			project_rules:
				"A rule is what a person of the project said that each agent follows (conduct) or knows as true (domain); only the user puts a rule in effect. Propose a rule with the `rule` tool, and never write a rule into `AGENTS.md`.\n3 done (domain): Done.",
		});

		await host?.close();
		host = undefined;
		await startFake(PROTOCOL_VERSION);

		expect(await agentStartSections(registered, ["read"])).toEqual({});
	});

	it("gives the session the memory tool and one memory snapshot of the host for the session", async () => {
		const tea = "The user drinks tea.";
		const paris = "The user lives in Paris.";
		await setSettings({ memoryModel: "faux/faux-2" });
		await installMemo();
		await seed({ notes: [tea, paris], pending: ["0-1"] });
		host = await startHost();
		const registered = await load();
		const tool = registered.tools.get("memory");

		expect(tool).toMatchObject(memoryTool({ Type }, ({ description, parameters }) => ({ description, parameters })));
		const section = { memory: `# Memory, oldest first\n#0 2026-11-15 ${tea}\n#1 2026-11-15 ${paris}` };
		expect(await agentStartSections(registered, ["read"])).toEqual(section);

		const before = calls.length;
		expect(await tool?.call({ action: "note", text: "The user has a cat." })).toBe("Saved as #2.");
		await until(() => readState().pending.length === 0);
		expect(
			calls
				.slice(before)
				.filter((call) => call.prompt.startsWith("Compress memories"))
				.map(({ provider, model, thinking }) => ({ provider, model, thinking })),
		).toEqual([{ provider: "faux", model: "faux-2", thinking: "low" }]);
		expect(await tool?.call({ action: "recall", pattern: "tea" })).toBe(`#0 2026-11-15 ${tea}\n1 matches.\n`);

		// The session keeps its first snapshot.
		expect(await agentStartSections(registered, ["read"])).toEqual(section);
		expect(memoCalls().filter((call) => call.args[0] === "wake")).toHaveLength(1);
	});

	it("fails the memory tool with the error of the host, and gives no memory section, when no host answers", async () => {
		await startFake(PROTOCOL_VERSION + 1);
		const old = await load();
		const mismatch = new Error(versionMismatch(PROTOCOL_VERSION, PROTOCOL_VERSION + 1, 7));

		await expect(old.tools.get("memory")?.call({ action: "recall", pattern: "tea" })).rejects.toThrow(mismatch);
		expect(await agentStartSections(old, ["read"])).toEqual({});

		await closeFake();
		await startFake(PROTOCOL_VERSION);
		const registered = await load();
		const tool = registered.tools.get("memory");

		await expect(tool?.call({ action: "note", text: "A note." })).rejects.toThrow(new Error("Invalid request"));
		await expect(tool?.call({ action: "note" })).rejects.toThrow(new Error("note requires text"));
		expect(await agentStartSections(registered, ["read"])).toEqual({});
	});

	it("gives no section about the tools of a cell to a session, also with the ipython tool", async () => {
		// A host that refuses every request, so the memory snapshot of the first turn starts no host.
		await startFake(PROTOCOL_VERSION);
		const registered = await load();

		expect(await agentStartSections(registered, ["read", "ipython"])).toEqual({});
		expect(await agentStartSections(registered, ["read", "bash"])).toEqual({});
	});

	it("gates each tool call of the session that is not a read, and asks the user about a held call with a UI", async () => {
		host = await startHost();
		models.setProvider(
			createProvider({
				id: "openrouter",
				auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: {} }) } },
				models: [gateClassifier()],
				classifiers: { "test-gate": { classify: classifyGate } },
			}),
		);
		gateStates.length = 0;
		const registered = await load();
		const person = await request({ type: "person", action: "add", name: "Sam" }, { start: false });
		const thread = await request({ type: "thread", action: "add", topic: "Go", persons: [1] }, { start: false });

		if (person === undefined || thread === undefined || !("id" in thread)) throw new Error("no host");

		const said = await request(
			{ type: "message", action: "log", caller: "cli", thread: thread.id, from: "user", direction: "in", text: "Ask." },
			{ start: false },
		);

		const rule = Value.Parse(
			Rule,
			await request(
				{
					type: "rule",
					action: "set",
					caller: "cli",
					name: "ask",
					kind: "conduct",
					value: "Ask first.",
					saidBy: "user",
					source: said?.id ?? 0,
				},
				{ start: false },
			),
		);

		await request({ type: "rule", action: "decide", caller: "user", id: rule.id }, { start: false });

		const reason = `It breaks rule ${rule.id} ask: Ask first.`;
		const push = { toolName: "bash", input: { command: "git push" } };

		/** The reply of the gate to the call `id` again, as a hook that runs again gets it. */
		const again = async (id: string) =>
			Value.Parse(
				GateReply,
				await request(
					{ type: "gate", requestId: id, caller: "session", tool: "bash", arguments: push.input, messages: [] },
					{ start: false },
				),
			);

		expect(
			await toolCall(registered, { toolName: "read", input: { path: "README.md" }, id: "read-1" }),
		).toBeUndefined();
		expect(gateStates).toEqual([]);

		// No refuses the call, and drops the held action.
		const prompts: string[] = [];
		expect(await toolCall(registered, { ...push, id: "call-1" }, false, prompts)).toEqual({
			block: true,
			reason: `Held as action 1: ${reason}`,
		});
		expect(prompts).toEqual([`Held action 1\ngit push\n\n${reason}`]);
		expect(await again("call-1")).toMatchObject({
			runs: false,
			held: { id: 1, state: "dropped", agent: "session", by: "session" },
		});
		expect(gateStates.at(-1)).toEqual({ action: "git push", last_user_messages: ["two", "three", "four"] });

		// Yes approves the held action, and the call runs, once.
		expect(await toolCall(registered, { ...push, id: "call-2" }, true, prompts)).toBeUndefined();
		expect(prompts).toHaveLength(2);
		expect(await again("call-2")).toEqual({ runs: true });
		expect(await again("call-3")).toMatchObject({ runs: false, held: { id: 3, state: "held" } });

		// Without a UI, the call is refused, and the action stays held.
		expect(await toolCall(registered, { ...push, id: "call-4" })).toEqual({
			block: true,
			reason: `Held as action 4: ${reason}`,
		});
		expect(prompts).toHaveLength(2);
		expect(await again("call-4")).toMatchObject({ runs: false, held: { id: 4, state: "held" } });
	});

	it("asks one time with a UI when the host does not answer, then runs the calls with no gate", async () => {
		await startFake(PROTOCOL_VERSION + 1);
		const mismatch = versionMismatch(PROTOCOL_VERSION, PROTOCOL_VERSION + 1, 7);
		const push = { toolName: "bash", input: { command: "git push" } };

		// No refuses the call, and the next call asks again.
		const refused = await load();
		const prompts: string[] = [];
		expect(await toolCall(refused, { ...push, id: "no-1" }, false, prompts)).toEqual({ block: true, reason: mismatch });
		expect(await toolCall(refused, { ...push, id: "no-2" }, false, prompts)).toEqual({ block: true, reason: mismatch });
		expect(prompts).toHaveLength(2);

		// Yes runs the calls at the same time and the later calls, after one prompt.
		const registered = await load();
		const asked: string[] = [];
		const calls = ["yes-1", "yes-2", "yes-3"].map((id) => toolCall(registered, { ...push, id }, true, asked));
		expect(await Promise.all(calls)).toEqual([undefined, undefined, undefined]);
		expect(await toolCall(registered, { ...push, id: "yes-4" }, true, asked)).toBeUndefined();
		expect(asked).toEqual([
			`The harness host does not answer\n${mismatch}\n\nRun the tool calls of this session with no gate until the host answers?`,
		]);
	});

	it("refuses a call without a UI when the host does not answer", async () => {
		await startFake(PROTOCOL_VERSION + 1);
		const registered = await load();

		expect(await toolCall(registered, { toolName: "bash", input: { command: "ls" }, id: "call-1" })).toEqual({
			block: true,
			reason: `The harness host does not answer, and this session has no UI to let it run with no gate: ${versionMismatch(PROTOCOL_VERSION, PROTOCOL_VERSION + 1, 7)}`,
		});
	});

	it("gates the calls again, with one note, when the host answers again", async () => {
		await startFake(PROTOCOL_VERSION + 1);
		const registered = await load();
		const push = { toolName: "bash", input: { command: "git push" } };
		const notes: string[] = [];

		expect(await toolCall(registered, { ...push, id: "call-1" }, true, [], notes)).toBeUndefined();
		await closeFake();
		host = await startHost();

		expect(await toolCall(registered, { ...push, id: "call-2" }, true, [], notes)).toBeUndefined();
		expect(notes).toEqual(["harness: the host answers again; the gate is back"]);
		expect(await toolCall(registered, { ...push, id: "call-3" }, true, [], notes)).toBeUndefined();
		expect(notes).toHaveLength(1);
	});

	it("refuses a call with the error that the host replies, with no prompt", async () => {
		await startFake(PROTOCOL_VERSION);
		const registered = await load();
		const prompts: string[] = [];

		expect(
			await toolCall(registered, { toolName: "bash", input: { command: "ls" }, id: "call-1" }, true, prompts),
		).toEqual({ block: true, reason: "Invalid request" });
		expect(prompts).toEqual([]);
	});
});
