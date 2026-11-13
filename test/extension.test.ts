import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import {
	type BeforeAgentStartEvent,
	createEventBus,
	type EventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionHandler,
	type NormalizedBuildSystemPromptOptions,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type extension from "../pi/index.ts";
import { request } from "../src/client/client.ts";
import { MIRROR_ENTRY, toMirrorEntry } from "../src/client/mirror.ts";
import type { Host } from "../src/host/run.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { Message } from "../src/protocol/project.ts";
import { MAIN_PROJECT } from "../src/protocol/projects.ts";
import { projectTools, TODO_TOOL_DESCRIPTION, TOOL_DESCRIPTION, todoToolSchemas } from "../src/tool.ts";
import { gates, rawReply, root, setUp, spawnAs, startHost, tearDown } from "./helpers.ts";

const run = promisify(execFile);
const LoggedMessage = Type.Object({ action: Type.Literal("log"), value: Message });
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAUX = { provider: "faux", model: "faux-1" };

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

type ToolContext = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

/** An event of Pi that the tests give to the extension's handlers. */
type PiEvent = SessionStartEvent | SessionShutdownEvent | BeforeAgentStartEvent;

/**
 * An event handler that the extension gives to `pi.on`; the tests call those of `session_start`, `session_shutdown` and
 * `before_agent_start`.
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
type Args = Readonly<Record<string, string | number | readonly string[] | readonly number[]>>;

/** A message that the extension sent to Pi, with its options. */
type Sent = { readonly text: string; readonly details: unknown; readonly options: unknown };

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
	readonly commands: Map<string, Command>;
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

/** The context of a tool call: the fields that the tool reads for `list`. */
function toolContext(): ToolContext {
	const ctx = {
		sessionManager: { getSessionId: () => "session" },
		model: undefined,
		cwd: root,
		isProjectTrusted: () => false,
	};

	// SAFETY: the tool reads only these fields of the context for `list` and `spawn`.
	return ctx as ToolContext;
}

/** Runs the extension against a fake Pi without flags, and gives what it registers. */
async function load(): Promise<Registered> {
	let calls = 0;

	const registered: Registered = {
		tools: new Map(),
		commands: new Map(),
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

				return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			};

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
			const text = Array.isArray(message.content)
				? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
				: message.content;

			registered.messages.push({ text, details: message.details, options });
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

/** The lines of the subagents widget and of the todo widget that the extension set, in order; undefined hides one. */
type Widgets = {
	readonly subagents: (readonly string[] | undefined)[];
	readonly todos: (readonly string[] | undefined)[];
};

/** Widgets that the extension did not set yet. */
function noWidgets(): Widgets {
	return { subagents: [], todos: [] };
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
 * `widgets` gets each content of the subagents widget and of the todo widget. With `mirror`, the session is a mirror
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
			// The extension gives the widget lines; only a mirror session gives components, which the tests do not draw.
			setWidget: (key: string, content: string[] | ((...args: never[]) => Component) | undefined) => {
				if ((key === "subagents" || key === "todos") && !(content instanceof Function)) widgets?.[key].push(content);
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

/**
 * A kernel of the Pi session: it runs the startup code in its argument, then, as cells would, spawns a child without a
 * model and waits for it, spawns a quiet child, and spawns with a context of 1 MiB + 1 byte. It prints the results as
 * JSON.
 */
const KERNEL_SCRIPT = [
	"import asyncio, json, sys",
	"namespace = {}",
	"for line in json.loads(sys.argv[1]):",
	"    exec(line, namespace)",
	"rlm = namespace['rlm']",
	"from harness_rlm import RlmError",
	"async def main():",
	"    child = await rlm.spawn('From the Pi kernel')",
	"    answer = await rlm.wait(child)",
	"    quiet = await rlm.spawn('Quiet from the Pi kernel')",
	"    try:",
	"        await rlm.spawn('Too large', context='x' * (1024 * 1024 + 1))",
	"        error = None",
	"    except RlmError as refused:",
	"        error = str(refused)",
	"    print(json.dumps({'child': child, 'answer': answer, 'quiet': quiet['handle'], 'error': error}))",
	"asyncio.run(main())",
].join("\n");

/** Waits until the child `handle` of the main host is idle. */
async function untilIdle(handle: string): Promise<void> {
	await vi.waitFor(
		async () => expect((await request({ type: "status", handle }, { start: false }))?.state).toBe("idle"),
		{ timeout: 10_000 },
	);
}

describe("the Pi extension", () => {
	it("uses its harness dependency without a harness on PATH", async () => {
		host = await startHost();
		const registered = await load();

		expect(registered.tools.get("subagent")?.description).toBe(TOOL_DESCRIPTION);
		expect(await callTool(registered, { action: "list" })).toBe("No subagents\n");
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

		const first = /^Spawned ([a-z0-9]+)$/m.exec(
			await callTool(registered, { action: "spawn", prompts: ["One"], ...FAUX }),
		)?.[1];

		await vi.waitFor(() => expect(registered.messages).toHaveLength(1), { timeout: 10_000 });
		expect(registered.messages[0]).toEqual({
			text: `subagent ${first} finished\n\nAnswer to Task:\nOne`,
			details: { handle: first, text: "Answer to Task:\nOne", failed: false },
			options: { triggerTurn: true, deliverAs: "followUp" },
		});

		// A wait after the message gives no answer twice.
		expect(await callTool(registered, { action: "wait", handle: first ?? "" })).toBe(
			`${first} finished\n\nNo new answers: the last answer came as a message.\n`,
		);

		// An answer that a wait gave is not sent again.
		gates.set("Task:\nGated", Promise.withResolvers());

		const gated = /^Spawned ([a-z0-9]+)$/m.exec(
			await callTool(registered, { action: "spawn", prompts: ["Gated"], ...FAUX }),
		)?.[1];

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

		await untilIdle(spawned?.handle ?? "");
		expect(registered.messages).toEqual([]);
		await sessionEvent(registered, { type: "session_start", reason: "startup" });
		await vi.waitFor(() => expect(registered.messages).toHaveLength(1), { timeout: 10_000 });
		expect(registered.messages[0]?.text).toContain("Answer to Task:\nBefore start");

		const handle = spawned?.handle ?? "";
		const input = { type: "input", requestId: "mirror", handle, message: "From mirror", followUp: false } as const;
		await request(input, { start: false });
		await untilIdle(handle);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" });
		await sessionEvent(registered, { type: "session_start", reason: "startup" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(registered.messages).toHaveLength(1);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" });
	});

	it("shows the children in the widget, an RLM child marked, and nothing without children or without a host", async () => {
		const registered = await load();
		const quiet = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, quiet);
		await vi.waitFor(() => expect(quiet.subagents).toEqual([undefined]), { timeout: 10_000 });
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, quiet);

		host = await startHost();
		const { handle } = await spawnAs("session", "Task:\nWidget", { notify: false });
		await untilIdle(handle);
		const { handle: rlm } = await spawnAs("session", "Task:\nWidget RLM", { notify: false, kind: "rlm" });
		await untilIdle(rlm);
		const widgets = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, widgets);
		const line = `<dim>subagents: <success>${handle}:idle<dim> | <success>rlm:${rlm}:idle`;
		await vi.waitFor(() => expect(widgets.subagents.at(-1)).toEqual([line]), { timeout: 10_000 });

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
		expect(options).toEqual([
			[`${handle}  idle      faux/faux-1  medium`, `${rlm}  idle      faux/faux-1  medium  rlm`],
		]);
		expect(registered.notifications).toEqual([
			{ message: `Run in another terminal: harness attach ${rlm}`, type: "info" },
		]);
		await host?.close();
		host = undefined;
		await vi.waitFor(() => expect(widgets.subagents.at(-1)).toBeUndefined(), { timeout: 10_000 });
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, widgets);
	});

	it("serves rlm to each kernel start of the session through the host, and closes its server at the session end", async () => {
		host = await startHost();
		const registered = await load();
		await sessionEvent(registered, { type: "session_start", reason: "startup" });

		registered.events.emit("ipython:kernel-starting", { env: {}, startupCode: [] });
		expect(registered.notifications).toEqual([
			{ message: "The ipython:kernel-starting event has an invalid payload; its kernel gets no rlm", type: "warning" },
		]);

		const { env, startupCode } = await kernelStart(registered);
		const socket = env.HARNESS_RLM_SOCKET ?? "";
		expect(socket).toMatch(/^\/tmp\/harness-rlm-[^/]+\/kernel\.sock$/);
		expect(env.HARNESS_RLM_TOKEN).toMatch(/^[0-9a-f]{64}$/);
		expect(process.env.HARNESS_RLM_SOCKET).toBeUndefined();
		expect(process.env.HARNESS_RLM_TOKEN).toBeUndefined();

		const { stdout } = await run("python3", ["-I", "-B", "-c", KERNEL_SCRIPT, JSON.stringify(startupCode)], {
			env: { ...process.env, ...env },
			timeout: 30_000,
		});

		const kernel = JSON.parse(stdout);

		// The child takes the model and the working directory of the session, and the host refuses the size of an RLM
		// spawn, so the spawns have `kind: "rlm"`.
		expect(kernel).toMatchObject({
			child: { ...FAUX, cwd: root },
			answer: "Answer to Task:\nFrom the Pi kernel",
			error: "The prompt of an RLM spawn, with its files and context, is more than 1 MiB",
		});

		// The children of the kernel are those of the session's tool.
		const listed = await callTool(registered, { action: "list" });
		expect(listed).toContain(kernel.child.handle);
		expect(listed).toContain(kernel.quiet);

		// The spawns have `notify: false`, so no answer comes as a message.
		await untilIdle(kernel.quiet);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(registered.messages).toEqual([]);

		// A new kernel start replaces the server.
		const restarted = (await kernelStart(registered)).env.HARNESS_RLM_SOCKET ?? "";
		expect(restarted).toMatch(/^\/tmp\/harness-rlm-[^/]+\/kernel\.sock$/);
		expect(restarted).not.toBe(socket);
		expect(existsSync(dirname(socket))).toBe(false);

		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" });
		await expect(rawReply(restarted, "{}")).rejects.toThrow("ENOENT");
		expect(existsSync(dirname(restarted))).toBe(false);
	});

	it("gives the todo tool of the host, on the list of the session and on the list of the project", async () => {
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
		expect(await todo?.call({ action: "add", text: "Write the plan" })).toBe("○ 1 Write the plan\n");
		expect(await todo?.call({ action: "add", text: "Ship it", list: "project" })).toBe("○ 1 Ship it\n");
		expect(await todo?.call({ action: "set", id: 1, state: "doing" })).toBe("◉ 1 Write the plan\n");
		expect(todo?.structured).toEqual([
			{ action: "add", value: { id: 1, text: "Write the plan", state: "open" } },
			{ action: "add", value: { id: 1, text: "Ship it", state: "open" } },
			{ action: "set", value: { id: 1, text: "Write the plan", state: "doing" } },
		]);

		const own = await request({ type: "todo", caller: "session", action: "list" }, { start: false });
		expect(own).toEqual({ todos: [{ id: 1, text: "Write the plan", state: "doing" }] });
		const project = await request({ type: "todo", caller: "cli", action: "list", handle: "agent" }, { start: false });
		expect(project).toEqual({ todos: [{ id: 1, text: "Ship it", state: "open" }] });
	});

	it("gives the thread, rule, term and part tools of the host, on the store of the project", async () => {
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
		expect(await tools.get("term")?.call({ action: "set", name: "hi", meaning: "hello", saidBy: "user", source })).toBe(
			`1 hi: hello [said by user in message ${source}]\n`,
		);
		expect(await tools.get("part")?.call({ action: "add", kind: "example", path: "parts/hi.md", rules: [1] })).toMatch(
			/^1 example parts\/hi\.md \[rules 1; terms none; checked .+\]\n$/,
		);
		await expect(tools.get("rule")?.call({ action: "set", id: 1, status: "retired", saidBy: 1 })).rejects.toThrow(
			"set requires source",
		);
		expect(await tools.get("thread")?.call({ action: "read", thread: thread.id })).toBe(
			`${thread.id} Pi with Sam (1): last message 2026-11-12T00:00:00.000Z\n${source} 2026-11-12T00:00:00.000Z Sam (1) (received): Hello\n`,
		);
		// The host keeps the session ID as the caller of each write.
		expect(await request({ type: "rule", action: "list" }, { start: false })).toMatchObject({
			rules: [{ id: 1, name: "hello", saidBy: 1, source, by: "session" }],
		});
		expect(await request({ type: "term", action: "list" }, { start: false })).toMatchObject({
			terms: [{ id: 1, by: "session" }],
		});
		expect(await request({ type: "part", action: "list" }, { start: false })).toMatchObject({
			parts: [{ id: 1, by: "session" }],
		});
		expect(await request({ type: "thread", action: "read", id: thread.id }, { start: false })).toMatchObject({
			thread: { last: at },
			messages: [{ id: source, text: "Hello", by: "session" }],
		});
	});

	it("shows the todos of the session while one is open or doing, at once after a call, only on a change, and nothing without a host", async () => {
		const registered = await load();
		const quiet = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, quiet);
		await vi.waitFor(() => expect(quiet.todos).toEqual([undefined]), { timeout: 10_000 });
		expect(existsSync(statePaths(MAIN_PROJECT).socket)).toBe(false);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, quiet);

		host = await startHost();
		const todo = registered.tools.get("todo");
		const widgets = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, widgets);
		await vi.waitFor(() => expect(widgets.todos).toEqual([undefined]), { timeout: 10_000 });
		await todo?.call({ action: "add", text: "Write the plan" });
		expect(widgets.todos.at(-1)).toEqual(["○ 1 Write the plan"]);
		await todo?.call({ action: "add", text: "Ship it" });
		await todo?.call({ action: "set", id: 1, state: "done" });
		await todo?.call({ action: "set", id: 2, state: "doing" });
		expect(widgets.todos.at(-1)).toEqual(["✓ 1 Write the plan", "◉ 2 Ship it"]);

		// A tick with the same lines does not set the widget again, which would move it below the subagents widget.
		const shown = widgets.todos.length;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(widgets.todos).toHaveLength(shown);
		await todo?.call({ action: "set", id: 2, state: "done" });
		expect(widgets.todos.at(-1)).toBeUndefined();
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, widgets);
	});

	it("does not show the todos of the local session in a mirror session", async () => {
		host = await startHost();
		await request({ type: "todo", caller: "session", action: "add", text: "Local" }, { start: false });
		const registered = await load();
		const widgets = noWidgets();
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, widgets, true);
		await vi.waitFor(() => expect(widgets.subagents).toEqual([undefined]), { timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(widgets.todos).toEqual([]);
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, widgets, true);
	});

	it("gives no rlm section to a session, also with the ipython tool", async () => {
		const registered = await load();

		expect(await agentStartSections(registered, ["read", "ipython"])).toEqual({});
		expect(await agentStartSections(registered, ["read", "bash"])).toEqual({});
	});
});
