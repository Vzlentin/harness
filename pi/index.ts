/**
 * The `subagent` tool, `/subagent`, the subagents widget, the messages with the answers of the children and the mirror
 * sessions of `/harness`. They use the client of `@vzlentin/harness`, the dependency of this package, from its built
 * `dist/`, and start the host of that install. The `.bin` folder that holds its `harness` command goes last on `PATH`.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type * as answers from "../dist/answers.js";
import type * as client from "../dist/client.js";
import type * as herdr from "../dist/herdr.js";
import type * as mirror from "../dist/mirror.js";
import type * as projects from "../dist/projects.js";
import type * as protocol from "../dist/protocol.js";
import type * as tool from "../dist/tool.js";
import type * as viewState from "../dist/view-state.js";
import { registerMirror } from "./mirror.ts";

/** The modules of the harness install that the extension uses. */
export type Harness = {
	readonly answers: typeof answers;
	readonly client: typeof client;
	readonly herdr: typeof herdr;
	readonly mirror: typeof mirror;
	readonly projects: typeof projects;
	readonly protocol: typeof protocol;
	readonly tool: typeof tool;
	readonly viewState: typeof viewState;
};

const HARNESS_PACKAGE = "@vzlentin/harness";

const SESSION_TRUST_HINT =
	"The child gets no project skills (.pi/skills, .agents/skills): this project is trusted for this Pi session only, and children see only the trust saved for future sessions. To give children project skills, run /trust and choose Trust.";

export default async function subagentExtension(pi: ExtensionAPI): Promise<void> {
	const require = createRequire(import.meta.url);
	putHarnessBinLast(require);
	registerHarness(pi, await loadHarness(require));
}

/**
 * Puts the `.bin` folder next to the harness package last on `PATH`, so Pi's tools find `harness`. It goes last because
 * the folder also holds the commands of other dependencies, such as an older `pi`, which must not hide the user's own.
 * It removes the folder first, so each load of the extension leaves it on `PATH` once.
 */
function putHarnessBinLast(require: NodeJS.Require): void {
	const modules = require.resolve
		.paths(HARNESS_PACKAGE)
		?.find((dir) => existsSync(join(dir, HARNESS_PACKAGE, "package.json")));

	if (modules === undefined) return;
	const bin = join(modules, ".bin");
	const rest = process.env.PATH ? process.env.PATH.split(delimiter).filter((entry) => entry !== bin) : [];
	process.env.PATH = [...rest, bin].join(delimiter);
}

/** Registers the tool, the commands, the flags and the widget, which use `harness`. */
function registerHarness(pi: ExtensionAPI, harness: Harness): void {
	const { client, herdr, protocol, tool } = harness;
	registerMirror(pi, harness);
	// One open `answers` request for each session brings the answers of its children as messages that start a turn.
	let listener: answers.AnswerListener | undefined;

	const deliver = (delivery: protocol.Delivery): void => {
		pi.sendMessage(
			{
				customType: "subagent-answer",
				content: [{ type: "text", text: protocol.deliveryText(delivery) }],
				display: true,
				details: delivery,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

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
		// A session that spawned children starts the host, so it gets the answers that came while Pi was closed.
		listener?.close();
		listener = new harness.answers.AnswerListener(ctx.sessionManager.getSessionId(), deliver, {
			start: hasSpawned(ctx),
		});

		if (!ctx.hasUI) return;
		widgetContext = ctx;
		void refreshWidget();
		widgetTimer = setInterval(() => void refreshWidget(), 1000);
		widgetTimer.unref();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		listener?.close();
		listener = undefined;

		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		widgetContext = undefined;
		ctx.ui.setWidget("subagents", undefined);
	});
}

/** Whether the session of `ctx` has a result of the `subagent` tool. */
function hasSpawned(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent",
		);
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

/** Loads the modules of the harness package that this extension resolves. A module that does not load makes the extension fail. */
async function loadHarness(require: NodeJS.Require): Promise<Harness> {
	const names = ["answers", "client", "herdr", "mirror", "projects", "protocol", "tool", "view-state"];
	const urls = names.map((name) => pathToFileURL(require.resolve(`${HARNESS_PACKAGE}/${name}`)).href);

	const [answers, client, herdr, mirror, projects, protocol, tool, viewState] = await Promise.all(
		urls.map((url) => import(url)),
	);

	// SAFETY: these are the built modules of the harness package, whose declarations the `Harness` type comes from.
	return { answers, client, herdr, mirror, projects, protocol, tool, viewState } as Harness;
}
