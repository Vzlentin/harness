/**
 * Mirror sessions: a Pi session that shows a child or the agent of a harness project in Pi's own chat, and sends what
 * the user types to it. The agent runs in the host of the project; the session keeps only its target, in one custom
 * entry. `/harness [project]` opens one in a new session, and `pi --harness <project> [--harness-child <handle> |
 * --harness-conversation <id>]` in the session that Pi starts with.
 */

import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
import type { MirrorTarget, PI_FLAGS } from "../dist/mirror.js";
import { Attachment } from "./attachment.ts";
import type { Harness } from "./index.ts";

/** The flags of a mirror session, which the extension registers also without harness. */
export const FLAGS: typeof PI_FLAGS = {
	project: "harness",
	child: "harness-child",
	conversation: "harness-conversation",
};

/** The mirror entry of a session: its ID and its target. */
type MirrorEntry = { readonly id: string; readonly target: MirrorTarget };

/** Registers `--harness`, `--harness-child` and `--harness-conversation`. */
export function registerFlags(pi: ExtensionAPI): void {
	pi.registerFlag(FLAGS.project, {
		type: "string",
		description: "Show the agent of this harness project (main or a project name) in the new session",
	});

	pi.registerFlag(FLAGS.child, {
		type: "string",
		description: "Show this subagent of the harness project in the new session, in place of the project agent",
	});

	pi.registerFlag(FLAGS.conversation, {
		type: "string",
		description:
			"Show this conversation of the children library of the harness project in the new session, in place of the project agent",
	});
}

/** Registers `/harness`, the flags and the handlers that turn a session with a mirror entry into a mirror session. */
export function registerMirror(pi: ExtensionAPI, harness: Harness): void {
	const { MIRROR_ENTRY } = harness.mirror;
	const { AGENT_HANDLE, errorMessage } = harness.protocol;
	// The frame of each mirror entry in Pi's chat. Pi can draw the entry before or after `session_start`.
	const frames = new Map<string, tui.Container>();
	let attached: Attachment | undefined;

	const frameOf = (entryId: string): tui.Container => {
		const frame = frames.get(entryId) ?? new tui.Container();
		frames.set(entryId, frame);

		return frame;
	};

	registerFlags(pi);

	pi.registerEntryRenderer(MIRROR_ENTRY, (entry, options, theme) => {
		if (attached?.entryId === entry.id) attached.restyle(theme, options.expanded);

		return frameOf(entry.id);
	});

	pi.registerCommand("harness", {
		description: "Show the agent of a harness project in a new session: /harness [project]",
		getArgumentCompletions: (prefix) => projectItems(harness, prefix),
		handler: async (args, ctx) => {
			let project: string | undefined;

			try {
				project = args.trim() === "" ? await pickProject(harness, ctx) : harness.projects.checkProject(args.trim());
			} catch (error) {
				ctx.ui.notify(`harness: ${errorMessage(error)}`, "error");

				return;
			}

			if (project === undefined) return;
			const target: MirrorTarget = { project, handle: AGENT_HANDLE };
			await ctx.newSession({
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(MIRROR_ENTRY, target);
				},
			});
		},
	});

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const branch = ctx.sessionManager.getBranch();

		// Pi draws only the entries of this branch from now on. A /reload keeps the session, and its frames.
		for (const id of frames.keys()) {
			if (!branch.some((entry) => entry.id === id)) frames.delete(id);
		}

		const entry =
			mirrorEntry(harness, branch) ?? (event.reason === "startup" ? flagEntry(pi, harness, ctx) : undefined);

		if (entry !== undefined) attached = new Attachment(pi, harness, ctx, entry.id, entry.target, frameOf(entry.id));
	});

	pi.on("session_shutdown", () => {
		attached?.close();
		attached = undefined;
	});

	// The agent of the host answers in a mirror session, so the input goes there and not to Pi's own agent.
	pi.on("input", (event, ctx) => {
		if (attached === undefined) return undefined;

		if (event.images !== undefined && event.images.length > 0) {
			ctx.ui.notify("harness: the images are not sent; the agent gets only the text", "warning");
		}

		attached.send(event.text, false);

		return { action: "handled" };
	});

	// A restored model is the one of the Pi session, not a choice of the user.
	pi.on("model_select", (event) => {
		if (event.source !== "restore") attached?.models.piSelected(event.model.provider, event.model.id);
	});
}

/** The newest mirror entry of `entries` with a valid target. */
function mirrorEntry(harness: Harness, entries: readonly SessionEntry[]): MirrorEntry | undefined {
	const { MIRROR_ENTRY, isMirrorTarget } = harness.mirror;

	for (const entry of entries.toReversed()) {
		if (entry.type === "custom" && entry.customType === MIRROR_ENTRY && isMirrorTarget(entry.data)) {
			return { id: entry.id, target: entry.data };
		}
	}

	return undefined;
}

/**
 * The mirror entry for `--harness <project>`, `--harness-child <handle>` and `--harness-conversation <id>`, written in
 * the session that Pi starts with. Without a project, it is the project of `HARNESS_PROJECT` and Pi's working
 * directory; without a child or a conversation, the project agent. It refuses both a child and a conversation, and a
 * session with messages, such as one of `--continue`, because Pi's own agent answered there.
 */
function flagEntry(pi: ExtensionAPI, harness: Harness, ctx: ExtensionContext): MirrorEntry | undefined {
	const { checkProject, resolveProject } = harness.projects;
	const { AGENT_HANDLE, errorMessage } = harness.protocol;
	const project = stringFlag(pi, FLAGS.project);
	const child = stringFlag(pi, FLAGS.child);
	const conversation = stringFlag(pi, FLAGS.conversation);

	if (project === undefined && child === undefined && conversation === undefined) return undefined;

	if (child && conversation) {
		ctx.ui.notify("harness: use --harness-child or --harness-conversation, not both", "error");

		return undefined;
	}

	if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) {
		ctx.ui.notify("harness: --harness needs a new session, not one with messages", "error");

		return undefined;
	}

	let target: MirrorTarget;

	try {
		const name = project ? checkProject(project) : resolveProject(process.env, ctx.cwd);
		target = conversation ? { project: name, conversation } : { project: name, handle: child || AGENT_HANDLE };
	} catch (error) {
		ctx.ui.notify(`harness: ${errorMessage(error)}`, "error");

		return undefined;
	}

	// `appendEntry` gives no entry ID, so the entry comes back from the branch.
	pi.appendEntry(harness.mirror.MIRROR_ENTRY, target);

	return mirrorEntry(harness, ctx.sessionManager.getBranch());
}

/** The value of the string flag `name`, or undefined when it is not given. */
function stringFlag(pi: ExtensionAPI, name: string): string | undefined {
	const flag = pi.getFlag(name);

	return flag === undefined || flag === true || flag === false ? undefined : flag;
}

/**
 * The project that the user selects for `/harness` without a project: the project of Pi's working directory first,
 * then the other projects and `main`. It is undefined when the user cancels.
 */
async function pickProject(harness: Harness, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const { MAIN_PROJECT, projectDir, readProjects, resolveProject } = harness.projects;
	const projects = readProjects();
	const current = resolveProject(process.env, ctx.cwd, projects);
	const names = [current, ...[...Object.keys(projects), MAIN_PROJECT].filter((name) => name !== current)];

	if (names.length === 1) return current;
	const labels = names.map((name) => `${name}  ${tildePath(projectDir(name, projects))}`);
	const label = await ctx.ui.select("Harness project", labels);

	return label === undefined ? undefined : names[labels.indexOf(label)];
}

/** `path` with the home directory as `~`. */
function tildePath(path: string): string {
	const home = homedir();

	return home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** The projects whose names start with `prefix`, for the argument of `/harness`. */
function projectItems(harness: Harness, prefix: string): AutocompleteItem[] | null {
	const { MAIN_PROJECT, readProjects } = harness.projects;
	let names: string[];

	try {
		names = [...Object.keys(readProjects()), MAIN_PROJECT];
	} catch {
		return null;
	}

	const items = names.flatMap((name) => (name.startsWith(prefix) ? [{ value: name, label: name }] : []));

	return items.length > 0 ? items : null;
}
