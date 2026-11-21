import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
	type AgentToolResult,
	createEventBus,
	type EventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionHandler,
	type ExtensionWidgetOptions,
	type SessionEntry,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type Theme,
	type WidgetPlacement,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type extension from "../pi/index.ts";
import { request } from "../src/client/client.ts";
import { MIRROR_ENTRY, toMirrorEntry } from "../src/client/mirror.ts";
import type { Host } from "../src/host/run.ts";
import { MAIN_HOST } from "../src/protocol/hosts.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { TODO_TOOL_DESCRIPTION, TOOL_DESCRIPTION, todoToolSchemas } from "../src/tool.ts";
import {
	drawWidget,
	gates,
	rawReply,
	root,
	setSettings,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	untilState,
} from "./helpers.ts";

const run = promisify(execFile);
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
type PiEvent = SessionStartEvent | SessionShutdownEvent;

/**
 * An event handler that the extension gives to `pi.on`; the tests call those of `session_start` and `session_shutdown`.
 */
type Handler = ExtensionHandler<PiEvent>;

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
	await host?.close();
	host = undefined;
	await tearDown();
});

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

/** The mirror entry of a mirror session of the host agent of `main`. */
const MIRROR = {
	type: "custom",
	customType: MIRROR_ENTRY,
	data: toMirrorEntry({ host: MAIN_HOST, target: { kind: "agent" } }),
	id: "mirror-1",
	parentId: null,
	timestamp: "",
} as const;

/**
 * Calls the handlers of `event` with harness, for the session `session` without entries, in `root` with the faux
 * model. Without `widgets`, the session has no UI. With it, the session has a UI whose theme writes `<colour>text`, and
 * `widgets` logs the sets and the removals of the subagents widget and of the todo widget, and each render of their components, at 80
 * columns, when they are set and when they ask for one. With `mirror`, the session is a mirror
 * session of the host agent in Pi's interactive mode, whose components are never drawn. The notifications go to
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

describe("the Pi extension", () => {
	it("uses its harness dependency without a harness on PATH", async () => {
		host = await startHost();
		const registered = await load();

		expect(registered.tools.get("subagent")?.description).toBe(TOOL_DESCRIPTION);
		expect(await callTool(registered, { action: "list" })).toBe("No subagents\n");
	});

	it("gives the session no tool, command, section or gate of the store of the host or of the memory", async () => {
		const registered = await load();

		expect(registered.handlers.get("before_agent_start")).toBeUndefined();
		expect(registered.handlers.get("tool_call")).toBeUndefined();

		for (const name of ["thread", "rule", "parley", "item", "memory"]) expect(registered.tools.has(name)).toBe(false);
		expect(registered.commands.has("rules")).toBe(false);
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
		const agentList = await request({ type: "todo", caller: "cli", action: "list", handle: "agent" }, { start: false });
		expect(agentList).toEqual({ todos: [] });
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

	it("shows the todos of the session while one is open or doing, at once after a call, only on a change, and nothing without a host", async () => {
		const registered = await load();
		const quiet = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, quiet);
		await vi.waitFor(() => expect(quiet.todos.renders).toEqual([[], []]), { timeout: 10_000 });
		expect(existsSync(statePaths(MAIN_HOST).socket)).toBe(false);
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
});
