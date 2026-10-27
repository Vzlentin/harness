import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import subagentExtension, { offerInstall } from "../pi/index.ts";
import { request } from "../src/client.ts";
import type { Host } from "../src/host.ts";
import { gates, logLines, root, setUp, startHost, tearDown } from "./helpers.ts";

const run = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(repo, "pi", "package.json"), "utf8"));
const MESSAGE = `harness ${version} is not installed: npm install -g @vzlentin/harness@${version}`;
const EXTENSION = join(repo, "pi", "index.ts");
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
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@vzlentin/harness", version }));
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
		getFlag: (name) => flags[name],
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

/** Calls the handlers of `event` with harness, for the session `session` without a UI and without entries. */
async function sessionEvent(registered: Registered, event: SessionStartEvent | SessionShutdownEvent): Promise<void> {
	const ctx: Pick<ExtensionContext, "hasUI"> & {
		readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries">;
		readonly ui: Pick<ExtensionContext["ui"], "setWidget">;
	} = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
		ui: { setWidget: () => {} },
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

	it("sends each answer of a child once as a message that starts a turn", async () => {
		await fakeNpm(globalRoot);
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
		await fakeNpm(globalRoot);
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

	it("waits until the install lock is free before it looks up harness", async () => {
		await fakeNpm(globalRoot);
		host = await startHost();
		const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });

		try {
			const lock = join(root, "state", "harness", "install.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "pid"), String(holder.pid));
			let loaded = false;

			const loading = load().then((registered) => {
				loaded = true;

				return registered;
			});

			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(loaded).toBe(false);
			await rm(lock, { recursive: true, force: true });

			expect(await callTool(await loading, { action: "list" })).toBe("No subagents\n");
		} finally {
			holder.kill();
		}
	});

	it("counts a harness older than the extension as not installed, and a newer one as installed", async () => {
		const manifest = join(globalRoot, "@vzlentin", "harness", "package.json");
		await fakeNpm(globalRoot);

		try {
			await writeFile(manifest, JSON.stringify({ name: "@vzlentin/harness", version: "0.0.1" }));
			expect(await callTool(await load(), {})).toBe(MESSAGE);

			host = await startHost();
			await writeFile(manifest, JSON.stringify({ name: "@vzlentin/harness", version: "99.0.0-rc.1" }));
			expect(await callTool(await load(), { action: "list" })).toBe("No subagents\n");
		} finally {
			await writeFile(manifest, JSON.stringify({ name: "@vzlentin/harness", version }));
		}
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
				// SAFETY: the session_start handlers without harness read only `mode` and `ui.notify`.
				await handler({ type: "session_start", reason }, { mode: "print", ui } as ExtensionContext);
			}
		}

		expect(notes).toEqual([[MESSAGE, "error"]]);
	});
});

/** How the fake `npm install -g` behaves: it sleeps `sleep` seconds first, and fails with 30 output lines on `fail`. */
type InstallBehaviour = { readonly sleep: number; readonly fail: boolean };

/** The log of the fake `npm` and of the `harness` that its install creates. */
function logPath(): string {
	return join(root, "log");
}

/** The npm prefix of the fake `npm`. */
function prefixPath(): string {
	return join(root, "prefix");
}

/**
 * A `npm` on `PATH` that logs its arguments. `npm install -g` creates `@vzlentin/harness` in the global root, with a
 * `dist/cli.js` that logs its arguments too.
 */
async function installingNpm(behaviour: InstallBehaviour): Promise<void> {
	const log = logPath();
	const dir = join(prefixPath(), "lib", "node_modules", "@vzlentin", "harness");

	const script = [
		"#!/bin/sh",
		`echo "npm $*" >> "${log}"`,
		`case "$1" in`,
		`prefix) echo "${prefixPath()}" ;;`,
		`root) echo "${join(prefixPath(), "lib", "node_modules")}" ;;`,
		"install)",
		`  sleep ${behaviour.sleep}`,
		behaviour.fail
			? `  i=1; while [ $i -le 30 ]; do echo "line $i"; i=$((i + 1)); done; echo "npm error failed" >&2; exit 1`
			: "  :",
		`  mkdir -p "${join(dir, "dist")}" "${join(prefixPath(), "bin")}"`,
		`  echo '{"name":"@vzlentin/harness","version":"${version}"}' > "${join(dir, "package.json")}"`,
		`  printf '#!/bin/sh\\necho "harness $*" >> "${log}"\\n' > "${join(dir, "dist", "cli.js")}"`,
		`  chmod +x "${join(dir, "dist", "cli.js")}"`,
		`  ln -s "${join(dir, "dist", "cli.js")}" "${join(prefixPath(), "bin", "harness")}"`,
		"  ;;",
		"esac",
	].join("\n");

	await writeFile(join(bin, "npm"), `${script}\n`);
	await chmod(join(bin, "npm"), 0o755);
}

/** A fake UI that answers `answer` to each dialog and records the dialogs and the notifications. */
function fakeUI(answer: boolean) {
	const dialogs: [string, string][] = [];
	const notes: [string, string | undefined][] = [];

	const ui: Pick<ExtensionContext["ui"], "confirm" | "notify"> = {
		confirm: async (title, message) => {
			dialogs.push([title, message]);

			return answer;
		},
		notify: (message, type) => {
			notes.push([message, type]);
		},
	};

	return { ui, dialogs, notes };
}

/** Calls the `session_start` handlers at startup in the mode `mode`, with `ui`. */
async function startSession(
	registered: Registered,
	mode: ExtensionContext["mode"],
	ui: Pick<ExtensionContext["ui"], "confirm" | "notify">,
): Promise<void> {
	for (const handler of registered.handlers.get("session_start") ?? []) {
		// SAFETY: the session_start handlers without harness read only `mode` and `ui`, and `hasUI` for the widget.
		await handler({ type: "session_start", reason: "startup" }, { mode, hasUI: true, ui } as ExtensionContext);
	}
}

/** Loads the extension without harness, and empties the log of the lookup. */
async function loadMissing(behaviour: InstallBehaviour): Promise<Registered> {
	await installingNpm(behaviour);
	const registered = await load();
	await rm(logPath(), { force: true });

	return registered;
}

/** Runs a process that imports the extension and runs the install offer with a UI that answers yes. */
function installer(): Promise<void> {
	const script = [
		`const { offerInstall } = await import(${JSON.stringify(EXTENSION)});`,
		`await offerInstall({ confirm: async () => true, notify: () => {} }, ${JSON.stringify(version)});`,
	].join("\n");

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit code ${code}`))));
	});
}

describe("the install offer", () => {
	const lock = (): string => join(root, "state", "harness", "install.lock");
	const declined = (): string => join(root, "state", "harness", "install.declined");

	it("installs harness and runs it when the answer is yes", async () => {
		const registered = await loadMissing({ sleep: 0, fail: false });
		const { ui, dialogs, notes } = fakeUI(true);
		await startSession(registered, "tui", ui);
		await vi.waitFor(() => expect(notes).toHaveLength(1), { timeout: 10_000 });

		expect(dialogs).toEqual([
			[
				`harness ${version} is not installed`,
				`Install @vzlentin/harness@${version} with npm install -g into ${prefixPath()}?`,
			],
		]);

		expect(logLines(logPath())).toEqual([
			"npm root -g",
			"npm prefix -g",
			`npm install -g @vzlentin/harness@${version}`,
			"npm root -g",
			"harness --version",
		]);

		expect(notes).toEqual([["harness installed, run /reload", "info"]]);
		expect(existsSync(lock())).toBe(false);
	});

	it("shows the end of the output and the command when npm install fails", async () => {
		const registered = await loadMissing({ sleep: 0, fail: true });
		const { ui, notes } = fakeUI(true);
		await startSession(registered, "tui", ui);
		await vi.waitFor(() => expect(notes).toHaveLength(1), { timeout: 10_000 });
		const tail = Array.from({ length: 19 }, (_, i) => `line ${i + 12}`);

		expect(notes).toEqual([
			[[...tail, "npm error failed", `Run by hand: npm install -g @vzlentin/harness@${version}`].join("\n"), "error"],
		]);

		expect(existsSync(lock())).toBe(false);
	});

	it("remembers a no and does not ask again", async () => {
		const registered = await loadMissing({ sleep: 0, fail: false });
		const { ui, dialogs, notes } = fakeUI(false);
		await startSession(registered, "tui", ui);
		await vi.waitFor(() => expect(existsSync(lock())).toBe(false), { timeout: 10_000 });

		expect(existsSync(declined())).toBe(true);
		const next = await load();
		await startSession(next, "tui", ui);
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(dialogs).toHaveLength(1);
		expect(notes).toEqual([]);
		expect(logLines(logPath())).not.toContain(`npm install -g @vzlentin/harness@${version}`);
		expect(await callTool(next, {})).toBe(MESSAGE);
	});

	it("does not ask in print mode or in RPC mode", async () => {
		const registered = await loadMissing({ sleep: 0, fail: false });
		const { ui, dialogs } = fakeUI(true);
		await startSession(registered, "print", ui);
		await startSession(registered, "rpc", ui);
		await new Promise((resolve) => setTimeout(resolve, 500));

		expect(dialogs).toEqual([]);
		expect(logLines(logPath())).toEqual([]);
	});

	it("does not ask again when an offer waits on the lock while the user answers no", async () => {
		await installingNpm({ sleep: 0, fail: false });
		const dialogs: string[] = [];

		const ui: Pick<ExtensionContext["ui"], "confirm" | "notify"> = {
			confirm: async (title) => {
				dialogs.push(title);
				await new Promise((resolve) => setTimeout(resolve, 300));

				return false;
			},
			notify: () => {},
		};

		await Promise.all([offerInstall(ui, version), offerInstall(ui, version)]);

		expect(dialogs).toHaveLength(1);
		expect(existsSync(declined())).toBe(true);
	});

	it("installs once when two processes offer at the same time", async () => {
		await installingNpm({ sleep: 1, fail: false });
		await Promise.all([installer(), installer()]);
		const installs = logLines(logPath()).filter((line) => line.startsWith("npm install"));

		expect(installs).toEqual([`npm install -g @vzlentin/harness@${version}`]);
	}, 30_000);
});
