import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionShutdownEvent,
	SessionStartEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type extension from "../pi/index.ts";
import { request } from "../src/client.ts";
import type { Host } from "../src/host.ts";
import { TOOL_DESCRIPTION } from "../src/tool.ts";
import { gates, root, setUp, startHost, tearDown } from "./helpers.ts";

const run = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAUX = { provider: "faux", model: "faux-1" };

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

type ToolContext = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

/** An event handler that the extension gives to `pi.on`; the tests call those of `session_start` and `session_shutdown`. */
type Handler = ExtensionHandler<SessionStartEvent | SessionShutdownEvent>;

/** A registered tool: its description, and a call with `args` that gives its text. */
type Tool = { readonly description: string; readonly call: (args: Args) => Promise<string> };

/** The arguments of a tool call in the tests. */
type Args = Readonly<Record<string, string | readonly string[]>>;

/** A message that the extension sent to Pi, with its options. */
type Sent = { readonly text: string; readonly details: unknown; readonly options: unknown };

/** What the extension registers in Pi. */
type Registered = {
	readonly tools: Map<string, Tool>;
	readonly commands: Map<string, Command>;
	readonly flags: string[];
	readonly handlers: Map<string, Handler[]>;
	readonly messages: Sent[];
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
	};

	const api: Pick<
		ExtensionAPI,
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
		registerTool: (tool) => {
			const call = async (args: Args) => {
				// SAFETY: the tests give the arguments of the tool's schema.
				const result = await tool.execute(`call-${++calls}`, args as never, undefined, undefined, toolContext());

				return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			};

			registered.tools.set(tool.name, { description: tool.description, call });
		},
		registerCommand: (name, command) => {
			registered.commands.set(name, command);
		},
		registerFlag: (name) => {
			registered.flags.push(name);
		},
		registerEntryRenderer: () => {},
		// SAFETY: the tests call only the `session_start` and `session_shutdown` handlers, whose type is `Handler`.
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
 * Calls the handlers of `event` with harness, for the session `session` without entries. Without `widgets`, the
 * session has no UI. With it, the session has a UI whose theme writes `<colour>text`, and `widgets` gets each content
 * of the subagents widget.
 */
async function sessionEvent(
	registered: Registered,
	event: SessionStartEvent | SessionShutdownEvent,
	widgets?: Widgets,
): Promise<void> {
	const ctx: Pick<ExtensionContext, "hasUI"> & {
		readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries" | "getBranch">;
		readonly ui: Pick<ExtensionContext["ui"], "setWidget"> & { readonly theme: Pick<Theme, "fg"> };
	} = {
		hasUI: widgets !== undefined,
		sessionManager: { getSessionId: () => "session", getEntries: () => [], getBranch: () => [] },
		ui: {
			// The extension gives the widget lines, never a component.
			setWidget: (key: string, content: string[] | ((...args: never[]) => Component) | undefined) => {
				if (key === "subagents" && !(content instanceof Function)) widgets?.push(content);
			},
			theme: { fg: (color, text) => `<${color}>${text}` },
		},
	};

	// SAFETY: with harness, the session handlers read only these fields of the context.
	const context = ctx as ExtensionContext;

	for (const handler of registered.handlers.get(event.type) ?? []) await handler(event, context);
}

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
});
