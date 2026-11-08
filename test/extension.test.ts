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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type extension from "../pi/index.ts";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { RLM_SECTION } from "../src/rlm/prompt.ts";
import { TOOL_DESCRIPTION } from "../src/tool.ts";
import { gates, rawReply, root, setUp, startHost, tearDown } from "./helpers.ts";

const run = promisify(execFile);
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

/** A registered tool: its description, and a call with `args` that gives its text. */
type Tool = {
	readonly description: string;
	readonly parameters: unknown;
	readonly call: (args: Args) => Promise<string>;
};

/** The arguments of a tool call in the tests. */
type Args = Readonly<Record<string, string | readonly string[]>>;

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
	const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
	await run(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(harness, "dist")], { cwd: repo });
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
			const call = async (args: Args) => {
				// SAFETY: the tests give the arguments of the tool's schema.
				const result = await tool.execute(`call-${++calls}`, args as never, undefined, undefined, toolContext());

				return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			};

			registered.tools.set(tool.name, { description: tool.description, parameters: tool.parameters, call });
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

/** The lines of the subagents widget that the extension set, in order; undefined hides the widget. */
type Widgets = (readonly string[] | undefined)[];

/**
 * Calls the handlers of `event` with harness, for the session `session` without entries, in `root` with the faux
 * model. Without `widgets`, the session has no UI. With it, the session has a UI whose theme writes `<colour>text`, and
 * `widgets` gets each content of the subagents widget. The notifications go to `registered`.
 */
async function sessionEvent(registered: Registered, event: PiEvent, widgets?: Widgets): Promise<void> {
	const ctx: Pick<ExtensionContext, "hasUI" | "cwd"> & {
		readonly model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
		readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries" | "getBranch">;
		readonly ui: Pick<ExtensionContext["ui"], "setWidget" | "notify"> & { readonly theme: Pick<Theme, "fg"> };
	} = {
		hasUI: widgets !== undefined,
		cwd: root,
		model: { provider: "faux", id: "faux-1" },
		sessionManager: { getSessionId: () => "session", getEntries: () => [], getBranch: () => [] },
		ui: {
			// The extension gives the widget lines, never a component.
			setWidget: (key: string, content: string[] | ((...args: never[]) => Component) | undefined) => {
				if (key === "subagents" && !(content instanceof Function)) widgets?.push(content);
			},
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

	it("shows in the widget the children, then that the host is not running, and nothing without children", async () => {
		const registered = await load();
		const quiet: Widgets = [];
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, quiet);
		await vi.waitFor(() => expect(quiet).toEqual([undefined]), { timeout: 10_000 });
		await sessionEvent(registered, { type: "session_shutdown", reason: "quit" }, quiet);

		host = await startHost();

		const spawned = await request(
			{
				type: "spawn",
				requestId: "widget",
				caller: "session",
				notify: false,
				provider: "faux",
				model: "faux-1",
				callerThinking: "medium",
				cwd: root,
				prompt: "Task:\nWidget",
			},
			{ start: false },
		);

		const handle = spawned?.handle ?? "";
		await untilIdle(handle);
		const widgets: Widgets = [];
		await sessionEvent(registered, { type: "session_start", reason: "startup" }, widgets);
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual([`<dim>subagents: <success>${handle}:idle`]), {
			timeout: 10_000,
		});
		await host?.close();
		host = undefined;
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["<warning>subagents: the harness host is not running"]), {
			timeout: 10_000,
		});
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

	it("gives the rlm section to a session with the ipython tool only", async () => {
		const registered = await load();

		expect(await agentStartSections(registered, ["read", "ipython"])).toEqual({ rlm: RLM_SECTION });
		expect(await agentStartSections(registered, ["read", "bash"])).toEqual({});
	});
});
