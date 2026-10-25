/**
 * The `subagent` tool, `/subagent`, the subagents widget and the mirror sessions of `/harness`. They use the client of
 * the global harness install, from its built `dist/`, and start the host of that install. Without harness, the tool,
 * the commands and the flags answer with the command that installs it, and an interactive session offers to install it.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type * as client from "../dist/client.js";
import type * as herdr from "../dist/herdr.js";
import type * as mirror from "../dist/mirror.js";
import type * as projects from "../dist/projects.js";
import type * as protocol from "../dist/protocol.js";
import type * as tool from "../dist/tool.js";
import type * as viewState from "../dist/view-state.js";
import { releaseInstallLock, stateFolder, takeInstallLock, waitInstallLockFree } from "./install-lock.ts";
import { FLAGS, registerFlags, registerMirror } from "./mirror.ts";

/** The modules of the global harness install that the extension uses. */
export type Harness = {
	readonly client: typeof client;
	readonly herdr: typeof herdr;
	readonly mirror: typeof mirror;
	readonly projects: typeof projects;
	readonly protocol: typeof protocol;
	readonly tool: typeof tool;
	readonly viewState: typeof viewState;
};

const HARNESS_PACKAGE = "@vzlentin/harness";
const HarnessManifest = Type.Object({ name: Type.Literal(HARNESS_PACKAGE) });
const OwnManifest = Type.Object({ version: Type.String() });
const CommandOutput = Type.Object({ stdout: Type.String(), stderr: Type.String() });
const runFile = promisify(execFile);

const SESSION_TRUST_HINT =
	"The child gets no project skills (.pi/skills, .agents/skills): this project is trusted for this Pi session only, and children see only the trust saved for future sessions. To give children project skills, run /trust and choose Trust.";

export default async function subagentExtension(pi: ExtensionAPI): Promise<void> {
	await waitInstallLockFree();
	const folder = harnessFolder();

	if (folder === undefined) {
		registerMissing(pi);

		return;
	}

	registerHarness(pi, await loadHarness(folder));
}

/**
 * Asks to install harness `version` with npm, and installs it when the answer is yes. It does nothing when the user
 * declined before (`install.declined` in the state folder) or when harness is found under the install lock. It shows
 * each failure as an error and never rejects.
 */
export async function offerInstall(ui: Pick<ExtensionUIContext, "confirm" | "notify">, version: string): Promise<void> {
	const declined = join(stateFolder(), "install.declined");
	const spec = `${HARNESS_PACKAGE}@${version}`;

	let held = false;

	if (existsSync(declined)) return;

	try {
		await takeInstallLock();
		held = true;

		if (existsSync(declined) || harnessFolder() !== undefined) return;
		const prefix = (await runUserCommand("npm", ["prefix", "-g"])).trim();

		if (!(await ui.confirm("harness is not installed", `Install ${spec} with npm install -g into ${prefix}?`))) {
			mkdirSync(stateFolder(), { recursive: true });
			writeFileSync(declined, "");

			return;
		}

		await runUserCommand("npm", ["install", "-g", spec]);
		const folder = harnessFolder();

		if (folder === undefined) throw new Error(`npm installed ${spec}, but harness is not found`);
		await runUserCommand(join(folder, "dist", "cli.js"), ["--version"]);
		ui.notify("harness installed, run /reload", "info");
	} catch (error) {
		const output = Value.Check(CommandOutput, error) ? `${error.stdout}\n${error.stderr}` : "";
		const reason = error instanceof Error ? error.message : String(error);

		const lines = (output.trim() === "" ? reason : output)
			.split("\n")
			.filter((line) => line.trim() !== "")
			.slice(-20);

		ui.notify([...lines, `Run by hand: npm install -g ${spec}`].join("\n"), "error");
	} finally {
		if (held) releaseInstallLock();
	}
}

/** Runs `file` with `PATH` without the `node_modules/.bin` folders, as the setup of harness does, and gives its stdout. */
async function runUserCommand(file: string, args: string[]): Promise<string> {
	const path = (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join("node_modules", ".bin")))
		.join(delimiter);

	const { stdout } = await runFile(file, args, {
		encoding: "utf8",
		env: { ...process.env, PATH: path },
		maxBuffer: 64 * 1024 * 1024,
	});

	return stdout;
}

/** Registers the tool, the commands, the flags and the widget, which use `harness`. */
function registerHarness(pi: ExtensionAPI, harness: Harness): void {
	const { client, herdr, protocol, tool } = harness;
	registerMirror(pi, harness);
	const { parameters, output } = tool.toolSchemas(Type);
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: tool.TOOL_DESCRIPTION,
		parameters,
		outputSchema: output,
		executionMode: "sequential",
		async execute(toolCallId, args, signal, _onUpdate, ctx) {
			const { text, data } = await tool.runTool(args, {
				caller: ctx.sessionManager.getSessionId(),
				callKey: toolCallId,
				provider: ctx.model?.provider,
				model: ctx.model?.id,
				thinking: pi.getThinkingLevel(),
				cwd: ctx.cwd,
				send: tool.sendToHost,
				signal,
			});

			// Children follow only the saved trust, so a session that trusts its project for itself says what the child misses.
			const sessionOnly =
				args.action === "spawn" &&
				ctx.isProjectTrusted() &&
				!savedTrust(ctx.cwd) &&
				!savedTrust(resolve(ctx.cwd, args.cwd ?? "."));

			const hint = sessionOnly ? `\n${SESSION_TRUST_HINT}\n` : "";

			return { content: [{ type: "text", text: text + hint }], details: undefined, structuredContent: data };
		},
	});

	pi.registerCommand("subagent", {
		description: "Open a subagent spawned by this session in Pi, in a new Herdr tab",
		handler: async (_args, ctx) => {
			const children = await client.request(
				{ type: "list", caller: ctx.sessionManager.getSessionId() },
				{ start: true },
			);

			if (children.length === 0) {
				ctx.ui.notify("No subagents spawned by this session", "info");

				return;
			}

			const chosen = await ctx.ui.select("Attach to subagent", children.map(protocol.childLine));

			// A name can start with the display name of another child, so the longest match is the chosen child.
			const child = children
				.filter((c: { handle: string; name?: string }) => chosen?.startsWith(`${protocol.runDisplayName(c)}  `))
				.sort(
					(a: { handle: string; name?: string }, b: { handle: string; name?: string }) =>
						protocol.runDisplayName(b).length - protocol.runDisplayName(a).length,
				)[0];

			if (child === undefined) return;
			const command = `harness attach ${child.handle}`;

			if (!herdr.inHerdr(process.env)) {
				ctx.ui.notify(`Run in another terminal: ${command}`, "info");

				return;
			}

			try {
				await herdr.openChildTab(child, process.env);
			} catch (error) {
				const message = protocol.errorMessage(error);
				ctx.ui.notify(`Could not open a Herdr tab: ${message}. Run in another terminal: ${command}`, "error");
			}
		},
	});

	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let widgetContext: ExtensionContext | undefined;
	let refreshing = false;

	// The widget does not start the host: when none runs, it shows nothing.
	const refreshWidget = async (): Promise<void> => {
		if (!widgetContext || refreshing) return;
		refreshing = true;

		try {
			const context = widgetContext;

			const children = await client
				.request({ type: "list", caller: context.sessionManager.getSessionId() }, { start: false })
				.catch(() => undefined);

			if (context !== widgetContext) return;

			if (children === undefined || children.length === 0) {
				context.ui.setWidget("subagents", undefined);

				return;
			}

			const theme = context.ui.theme;

			const visible = children
				.slice(0, 5)
				.map(({ name, handle, state }: { name?: string; handle: string; state: string }) => {
					const color = state === "busy" ? "warning" : state === "idle" ? "success" : "error";

					return theme.fg(color, `${name ?? handle}:${state}`);
				});

			if (children.length > visible.length) visible.push(theme.fg("muted", `+${children.length - visible.length}`));
			context.ui.setWidget("subagents", [theme.fg("dim", "subagents: ") + visible.join(theme.fg("dim", " | "))], {
				placement: "belowEditor",
			});
		} finally {
			refreshing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		widgetContext = ctx;
		void refreshWidget();
		widgetTimer = setInterval(() => void refreshWidget(), 1000);
		widgetTimer.unref();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		widgetContext = undefined;
		ctx.ui.setWidget("subagents", undefined);
	});
}

/**
 * Whether Pi trusts the project in `cwd` with no one to ask, as the host does in `src/trust.ts` of harness. It is here
 * with Pi's own modules, so Pi does not load the copy of pi-coding-agent that harness installs.
 */
function savedTrust(cwd: string): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	const agentDir = getAgentDir();
	const decision = new ProjectTrustStore(agentDir).get(cwd);

	if (decision !== null) return decision;

	return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
}

/**
 * The folder of the global harness install: the package of the first `harness` on `PATH`, else the package in the
 * global `node_modules` of npm. A folder counts only when its `package.json` names `@vzlentin/harness`.
 */
function harnessFolder(): string | undefined {
	const onPath = pathFolder();

	if (onPath !== undefined && isHarness(onPath)) return onPath;
	const global = npmFolder();

	return global !== undefined && isHarness(global) ? global : undefined;
}

/** The package of the first `harness` on `PATH`: `<package>/dist/cli.js` is the real path of the command. */
function pathFolder(): string | undefined {
	try {
		const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");
		const command = dirs.map((dir) => join(dir, "harness")).find((path) => existsSync(path));

		return command === undefined ? undefined : dirname(dirname(realpathSync(command)));
	} catch {
		return undefined;
	}
}

/** The harness package in the global `node_modules` of npm. */
function npmFolder(): string | undefined {
	try {
		const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

		return join(root.trim(), HARNESS_PACKAGE);
	} catch {
		return undefined;
	}
}

function isHarness(folder: string): boolean {
	try {
		return Value.Check(HarnessManifest, JSON.parse(readFileSync(join(folder, "package.json"), "utf8")));
	} catch {
		return false;
	}
}

/** Loads the modules of the harness install in `folder`. A module that does not load makes the extension fail. */
async function loadHarness(folder: string): Promise<Harness> {
	const names = ["client", "herdr", "mirror", "projects", "protocol", "tool", "view-state"];
	const urls = names.map((name) => pathToFileURL(join(folder, "dist", `${name}.js`)).href);

	const [client, herdr, mirror, projects, protocol, tool, viewState] = await Promise.all(
		urls.map((url) => import(url)),
	);

	// SAFETY: these are the built modules of the harness package, whose declarations the `Harness` type comes from.
	return { client, herdr, mirror, projects, protocol, tool, viewState } as Harness;
}

/** Registers the tool, the commands and the flags without harness: each one gives the command that installs it. */
function registerMissing(pi: ExtensionAPI): void {
	const { version } = Value.Parse(
		OwnManifest,
		JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")),
	);

	const message = `harness is not installed: npm install -g ${HARNESS_PACKAGE}@${version}`;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: message,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: message }], details: undefined };
		},
	});

	pi.registerCommand("subagent", {
		description: message,
		handler: async (_args, ctx) => ctx.ui.notify(message, "error"),
	});

	pi.registerCommand("harness", {
		description: message,
		getArgumentCompletions: () => null,
		handler: async (_args, ctx) => ctx.ui.notify(message, "error"),
	});

	registerFlags(pi);

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") return;

		if (Object.values(FLAGS).some((name) => pi.getFlag(name) !== undefined)) ctx.ui.notify(message, "error");
	});

	// Pi waits for each handler, so the session starts while the dialog and the install run.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		void offerInstall(ctx.ui, version);
	});
}
