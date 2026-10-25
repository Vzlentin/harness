import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import subagentExtension from "../pi/index.ts";
import type { Host } from "../src/host.ts";
import { root, setUp, startHost, tearDown } from "./helpers.ts";

const run = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(repo, "pi", "package.json"), "utf8"));
const MESSAGE = `harness is not installed: npm install -g @vzlentin/harness@${version}`;

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

type ToolContext = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

/** An event handler that the extension gives to `pi.on`; the tests call only those of `session_start`. */
type Handler = ExtensionHandler<SessionStartEvent>;

/** A registered tool: its description, and a call with `args` that gives its text. */
type Tool = { readonly description: string; readonly call: (args: Record<string, string>) => Promise<string> };

/** What the extension registers in Pi. */
type Registered = {
	readonly tools: Map<string, Tool>;
	readonly commands: Map<string, Command>;
	readonly flags: string[];
	readonly handlers: Map<string, Handler[]>;
};

/** The global `node_modules` folder of the fake install, with `@vzlentin/harness` built from this checkout. */
let globalRoot: string;
let bin: string;
let host: Host | undefined;

beforeAll(async () => {
	const prefix = realpathSync(await mkdtemp(join(tmpdir(), "harness-extension-")));
	globalRoot = join(prefix, "lib", "node_modules");
	const dir = join(globalRoot, "@vzlentin", "harness");
	const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
	await run(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(dir, "dist")], { cwd: repo });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@vzlentin/harness", version: "0.0.1" }));
	await symlink(join(repo, "node_modules"), join(dir, "node_modules"));
}, 60_000);

afterAll(async () => {
	await rm(dirname(dirname(globalRoot)), { recursive: true, force: true });
});

beforeEach(async () => {
	await setUp();
	bin = await mkdtemp(join(root, "bin-"));
	// Only the fake commands: the `harness` of the user must not be found.
	process.env.PATH = [bin, "/usr/bin", "/bin"].join(delimiter);
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	await tearDown();
});

/** A `npm` on `PATH` whose `npm root -g` prints `folder`. */
async function fakeNpm(folder: string): Promise<void> {
	await writeFile(join(bin, "npm"), `#!/bin/sh\necho "${folder}"\n`);
	await chmod(join(bin, "npm"), 0o755);
}

/** The context of a tool call: the fields that the tool reads for `list`. */
function toolContext(): ToolContext {
	const ctx = {
		sessionManager: { getSessionId: () => "session" },
		model: undefined,
		cwd: root,
		isProjectTrusted: () => false,
	};

	// SAFETY: the tool reads only these fields of the context for `list` and without harness.
	return ctx as ToolContext;
}

/** Runs the extension against a fake Pi whose flags are `flags`, and gives what it registers. */
async function load(flags: Record<string, string> = {}): Promise<Registered> {
	const registered: Registered = { tools: new Map(), commands: new Map(), flags: [], handlers: new Map() };

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
	> = {
		registerTool: (tool) => {
			const call = async (args: Record<string, string>) => {
				// SAFETY: the tests give the arguments of the tool's schema.
				const result = await tool.execute("call", args as never, undefined, undefined, toolContext());

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
		// SAFETY: the tests call only the `session_start` handlers, whose type is `Handler`.
		on: ((event: string, handler: Handler) => {
			registered.handlers.set(event, [...(registered.handlers.get(event) ?? []), handler]);

			return () => {};
		}) as ExtensionAPI["on"],
		getFlag: (name) => flags[name],
		getThinkingLevel: () => "off",
		appendEntry: () => {},
	};

	// SAFETY: the extension calls only these functions while it loads and in the tool and commands of the tests.
	await subagentExtension(api as ExtensionAPI);

	return registered;
}

/** The text that the `subagent` tool gives for `args`. */
async function callTool(registered: Registered, args: Record<string, string>): Promise<string> {
	const tool = registered.tools.get("subagent");

	if (tool === undefined) throw new Error("no subagent tool");

	return tool.call(args);
}

describe("the Pi extension", () => {
	it("uses the package of the first harness on PATH", async () => {
		await symlink(join(globalRoot, "@vzlentin", "harness", "dist", "cli.js"), join(bin, "harness"));
		await fakeNpm(await mkdtemp(join(root, "empty-")));
		host = await startHost();

		expect(await callTool(await load(), { action: "list" })).toBe("No subagents\n");
	});

	it("uses the package in npm's global root when harness is not on PATH", async () => {
		await fakeNpm(globalRoot);
		host = await startHost();

		expect(await callTool(await load(), { action: "list" })).toBe("No subagents\n");
	});

	it("answers with the install command when harness is not installed", async () => {
		await fakeNpm(await mkdtemp(join(root, "empty-")));
		const registered = await load();

		expect([...registered.tools.keys()]).toEqual(["subagent"]);
		expect(registered.tools.get("subagent")?.description).toBe(MESSAGE);
		expect(await callTool(registered, {})).toBe(MESSAGE);
		expect([...registered.commands.keys()].sort()).toEqual(["harness", "subagent"]);
		expect(registered.flags).toEqual(["harness", "harness-child", "harness-conversation"]);

		for (const command of registered.commands.values()) {
			const notes: [string, string | undefined][] = [];

			const ui: Pick<ExtensionCommandContext["ui"], "notify"> = {
				notify: (message, type) => {
					notes.push([message, type]);
				},
			};

			// SAFETY: the commands without harness use only `ui.notify`.
			await command.handler("", { ui } as ExtensionCommandContext);
			expect(notes).toEqual([[MESSAGE, "error"]]);
		}
	});

	it("shows the install notice for a harness flag only at startup when harness is not installed", async () => {
		await fakeNpm(await mkdtemp(join(root, "empty-")));
		const registered = await load({ harness: "main" });
		const notes: [string, string | undefined][] = [];

		const ui: Pick<ExtensionContext["ui"], "notify"> = {
			notify: (message, type) => {
				notes.push([message, type]);
			},
		};

		const reasons: SessionStartEvent["reason"][] = ["startup", "new", "resume", "fork", "reload"];

		for (const reason of reasons) {
			for (const handler of registered.handlers.get("session_start") ?? []) {
				// SAFETY: the session_start handler without harness uses only `ui.notify`.
				await handler({ type: "session_start", reason }, { ui } as ExtensionContext);
			}
		}

		expect(notes).toEqual([[MESSAGE, "error"]]);
	});
});
