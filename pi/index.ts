/**
 * The `subagent` tool, `/subagent`, the subagents widget, the messages with the answers of the children, the `todo`
 * tool and the todo widget, the mirror sessions of `/harness` and `rlm` in the IPython kernels of the session. They use
 * the client of `@vzlentin/harness`, the dependency of this package, from its built `dist/`, and start the host of that
 * install. The `.bin` folder that holds its `harness` command goes last on `PATH`.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type * as answers from "../dist/client/answers.js";
import type * as client from "../dist/client/client.js";
import type * as herdr from "../dist/client/herdr.js";
import type * as mirror from "../dist/client/mirror.js";
import type * as viewState from "../dist/client/view-state.js";
import type * as protocol from "../dist/protocol/index.js";
import type * as projects from "../dist/protocol/projects.js";
import type * as trust from "../dist/protocol/trust.js";
import type * as rlm from "../dist/rlm/index.js";
import type * as tool from "../dist/tool.js";
import { registerMirror } from "./mirror.ts";
import { PolledWidget } from "./polled-widget.ts";
import { registerRlm } from "./rlm.ts";
import { registerTodo } from "./todo.ts";

/** The modules of the harness install that the extension uses. */
export type Harness = {
	readonly answers: typeof answers;
	readonly client: typeof client;
	readonly herdr: typeof herdr;
	readonly mirror: typeof mirror;
	readonly projects: typeof projects;
	readonly protocol: typeof protocol;
	readonly rlm: typeof rlm;
	readonly tool: typeof tool;
	readonly trust: typeof trust;
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
	// Pi's own modules, so Pi does not load the copy of pi-coding-agent that harness installs.
	const piTrust = { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager };
	const savedTrust = (cwd: string) => harness.trust.savedTrust(cwd, piTrust);
	// Pi runs the handlers in the order of registration, so the todo widget knows a mirror session at its start.
	const mirrored = registerMirror(pi, harness);
	registerRlm(pi, harness, sessionScope);
	registerTodo(pi, harness, mirrored);
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

	const { parameters, output } = tool.toolSchemas({ Type });
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: tool.TOOL_DESCRIPTION,
		parameters,
		outputSchema: output,
		executionMode: "sequential",
		async execute(toolCallId, args, signal, _onUpdate, ctx) {
			const { text, data } = await tool.runTool(args, {
				...sessionScope(pi, ctx),
				callKey: toolCallId,
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
		description: "Open a subagent spawned by this session in Pi, in a new herdr-app tab",
		handler: async (_args, ctx) => {
			const children: readonly protocol.ChildInfo[] = await client.request(
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
				.filter((c) => chosen?.startsWith(`${protocol.runDisplayName(c)}  `))
				.sort((a, b) => protocol.runDisplayName(b).length - protocol.runDisplayName(a).length)[0];

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
				ctx.ui.notify(`Could not open a herdr-app tab: ${message}. Run in another terminal: ${command}`, "error");
			}
		},
	});

	const subagents = new PolledWidget(
		"subagents",
		async (ctx) => {
			const children = await client.request(
				{ type: "list", caller: ctx.sessionManager.getSessionId() },
				{ start: false },
			);

			return widgetLines(ctx.ui.theme, children);
		},
		protocol.errorMessage,
	);

	pi.on("session_start", (_event, ctx) => {
		// A session that spawned children starts the host, so it gets the answers that came while Pi was closed.
		listener?.close();
		// A write to stderr would break the TUI, so a delivery that fails is a notification.
		listener = new harness.answers.AnswerListener(ctx.sessionManager.getSessionId(), deliver, {
			start: hasSpawned(ctx),
			onError: (error) =>
				ctx.ui.notify(`Could not show the answer of a subagent: ${protocol.errorMessage(error)}`, "error"),
		});

		subagents.start(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		listener?.close();
		listener = undefined;
		subagents.stop(ctx);
	});
}

/**
 * The lines of the subagents widget for `children`, the reply of `list`: nothing for no host (undefined) and for no
 * children. An RLM child starts with its marker.
 */
function widgetLines(
	theme: ExtensionContext["ui"]["theme"],
	children: readonly protocol.ChildInfo[] | undefined,
): string[] | undefined {
	if (children === undefined || children.length === 0) return undefined;

	const visible = children.slice(0, 5).map(({ name, handle, state, kind }) => {
		const label = `${name ?? handle}:${state}`;

		return theme.fg(STATE_COLORS[state], kind === undefined ? label : `${kind}:${label}`);
	});

	if (children.length > visible.length) visible.push(theme.fg("muted", `+${children.length - visible.length}`));

	return [theme.fg("dim", "subagents: ") + visible.join(theme.fg("dim", " | "))];
}

/** The theme colour of a child in each state. */
const STATE_COLORS: Record<protocol.ChildState, "warning" | "success" | "error" | "muted"> = {
	busy: "warning",
	idle: "success",
	error: "error",
	closed: "muted",
};

/**
 * The caller of the calls of the session of `ctx`, with its tool or its `rlm`, and their spawn defaults: the session ID,
 * the model, the thinking level and the working directory, read now.
 */
function sessionScope(pi: ExtensionAPI, ctx: ExtensionContext): rlm.KernelScope {
	return {
		caller: ctx.sessionManager.getSessionId(),
		provider: ctx.model?.provider,
		model: ctx.model?.id,
		thinking: pi.getThinkingLevel(),
		cwd: ctx.cwd,
	};
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

/** Loads the modules of the harness package that this extension resolves. A module that does not load makes the extension fail. */
async function loadHarness(require: NodeJS.Require): Promise<Harness> {
	const names = ["answers", "client", "herdr", "mirror", "projects", "protocol", "rlm", "tool", "trust", "view-state"];
	const urls = names.map((name) => pathToFileURL(require.resolve(`${HARNESS_PACKAGE}/${name}`)).href);

	const [answers, client, herdr, mirror, projects, protocol, rlm, tool, trust, viewState] = await Promise.all(
		urls.map((url) => import(url)),
	);

	// SAFETY: these are the built modules of the harness package, whose declarations the `Harness` type comes from.
	return { answers, client, herdr, mirror, projects, protocol, rlm, tool, trust, viewState } as Harness;
}
