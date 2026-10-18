/**
 * Mirror sessions: a Pi session that shows a child or the agent of a harness project in Pi's own chat, and sends what
 * the user types to it. The agent runs in the host of the project; the session keeps only its target, in one custom
 * entry. `/harness [project]` opens one in a new session, and `pi --harness <project> [--harness-child <handle>]` in the
 * session that Pi starts with.
 */

import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	KeybindingsManager,
	SessionEntry,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import * as coding from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { AutocompleteItem, Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
import { type AgentReporter, agentReporter } from "../dist/herdr.js";
import { isMirrorTarget, MIRROR_ENTRY, Mirror, type MirrorConfigure, type MirrorTarget } from "../dist/mirror.js";
import { checkProject, MAIN_PROJECT, projectDir, readProjects, resolveProject } from "../dist/projects.js";
import { AGENT_HANDLE, type ChildInfo, childLabel, childTitle } from "../dist/protocol.js";
import { inboxOf, lastAnswerUsage, liveOf, queued, statusText, usageTotals } from "../dist/view-state.js";
import { ChatView } from "./chat.ts";

/** The key of the status widget above the editor. */
const WIDGET = "harness-mirror";

/** The mirror entry of a session: its ID and its target. */
type MirrorEntry = { readonly id: string; readonly target: MirrorTarget };

/** Registers `/harness`, `--harness` and the handlers that turn a session with a mirror entry into a mirror session. */
export function registerMirror(pi: ExtensionAPI): void {
	// The frame of each mirror entry in Pi's chat. Pi can draw the entry before or after `session_start`.
	const frames = new Map<string, tui.Container>();
	let attached: Attachment | undefined;

	const frameOf = (entryId: string): tui.Container => {
		const frame = frames.get(entryId) ?? new tui.Container();
		frames.set(entryId, frame);

		return frame;
	};

	pi.registerFlag("harness", {
		type: "string",
		description: "Show the agent of this harness project (main or a project name) in the new session",
	});

	pi.registerFlag("harness-child", {
		type: "string",
		description: "Show this subagent of the harness project in the new session, in place of the project agent",
	});

	pi.registerEntryRenderer(MIRROR_ENTRY, (entry, options, theme) => {
		if (attached?.entryId === entry.id) attached.restyle(theme, options.expanded);

		return frameOf(entry.id);
	});

	pi.registerCommand("harness", {
		description: "Show the agent of a harness project in a new session: /harness [project]",
		getArgumentCompletions: projectItems,
		handler: async (args, ctx) => {
			let project: string | undefined;

			try {
				project = args.trim() === "" ? await pickProject(ctx) : checkProject(args.trim());
			} catch (error) {
				ctx.ui.notify(`harness: ${errorText(error)}`, "error");

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
		const found = mirrorEntry(ctx.sessionManager.getBranch());
		const entry = found ?? (event.reason === "startup" ? flagEntry(pi, ctx) : undefined);

		if (entry !== undefined) attached = new Attachment(pi, ctx, entry, frameOf(entry.id));
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
		if (event.source !== "restore") attached?.selectModel(event.model.provider, event.model.id);
	});
}

/**
 * The mirror of one Pi session: the frame of its entry in Pi's chat, which holds the transcript, the status above the
 * editor, and an editor whose interrupt and follow-up keys act on the agent while it works. The connection to the host
 * is the `Mirror`.
 */
class Attachment {
	readonly entryId: string;
	// After a session switch, `#pi` and `#ctx` are stale and throw, so only code that checks `#closed` uses them. The
	// components that Pi draws use `#theme` instead.
	readonly #pi: ExtensionAPI;
	readonly #ctx: ExtensionContext;
	#theme: Theme;
	readonly #frame: tui.Container;
	readonly #status = new StatusArea();
	readonly #mirror: Mirror;
	#ui: TUI | undefined;
	#chat: ChatView | undefined;
	/** The state of the agent for Herdr, made when the agent is first known. */
	#reporter: AgentReporter | undefined;
	/** True while Pi sets the agent's model: `setModel` is async, and the view changes often while the agent works. */
	#settingModel = false;
	/** Whether the connection was open at the last update, so that the running tool cards stop once when it ends. */
	#open = false;
	#failureShown = false;
	#expanded = false;
	#closed = false;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, entry: MirrorEntry, frame: tui.Container) {
		this.entryId = entry.id;
		this.#pi = pi;
		this.#ctx = ctx;
		this.#theme = ctx.ui.theme;
		this.#frame = frame;
		this.#frame.clear();
		this.#frame.addChild(this.#line("muted", () => `Connecting to the ${targetTitle(entry.target)}...`));
		// Pi calls the factory at once, which gives the TUI that the tool cards need.
		ctx.ui.setWidget(
			WIDGET,
			(ui, theme) => {
				this.#ui = ui;
				this.#theme = theme;

				return this.#status;
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setEditorComponent((ui, theme, keybindings) => new MirrorEditor(ui, theme, keybindings, this));
		this.#mirror = new Mirror(entry.target, () => this.#update());
	}

	get busy(): boolean {
		return this.#mirror.busy;
	}

	/**
	 * Sends `text` to the agent: a new turn when it is idle, else a steer, or a follow-up with `followUp`. A text that
	 * does not reach the agent goes back to the editor, after the text there, so it is not lost.
	 */
	send(text: string, followUp: boolean): void {
		this.#mirror.send(text, followUp).catch((cause: unknown) => {
			if (this.#closed) return;
			const editor = this.#ctx.ui.getEditorText();
			this.#ctx.ui.setEditorText([editor, text].filter((part) => part.trim() !== "").join("\n\n"));
			this.#ctx.ui.notify(`harness: not sent: ${errorText(cause)}`, "error");
		});
	}

	/** Aborts the agent's turn. The queued messages that the host withdraws go back to `editor`, steers first. */
	abort(editor: Pick<tui.Editor, "getText" | "setText">): void {
		this.#mirror.abort().then(
			(texts) => {
				if (this.#closed) return;
				const text = [...texts, editor.getText()].filter((part) => part.trim() !== "").join("\n\n");

				if (text !== editor.getText()) editor.setText(text);
			},
			(cause: unknown) => this.#notify(cause),
		);
	}

	/** Gives the agent the model that the user selected in Pi. */
	selectModel(provider: string, model: string): void {
		const child = this.#mirror.child;

		if (child === undefined || (child.provider === provider && child.model === model)) return;
		this.#configure({ provider, model });
	}

	/** Gives the agent the thinking level that the user cycled to in Pi, once Pi has the agent's model. */
	cycledThinking(): void {
		const child = this.#mirror.child;
		const thinking = this.#pi.getThinkingLevel();

		if (child === undefined || child.thinking === thinking || !this.#hasAgentModel(child)) return;
		this.#configure({ thinking });
	}

	/** Takes the theme and the expanded state of tool output that Pi gives when it draws the entry again. */
	restyle(theme: Theme, expanded: boolean): void {
		this.#theme = theme;
		this.#expanded = expanded;
		this.#chat?.setExpanded(expanded);
		this.showThinkingSetting();
	}

	/** Shows or hides the thinking of the answers, as Pi's `hideThinkingBlock` setting says. */
	showThinkingSetting(): void {
		if (!this.#closed) this.#chat?.setHideThinking(this.#pi.getSettings().hideThinkingBlock ?? false);
	}

	/** Closes the connection and gives Pi back its editor. The agent keeps running in the host. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#mirror.close();
		this.#chat?.stopTimers();
		this.#status.dispose();
		this.#ctx.ui.setWidget(WIDGET, undefined);
		this.#ctx.ui.setEditorComponent(undefined);
		void this.#reporter?.release();
	}

	/**
	 * Shows the mirror: the transcript, the status above the editor and a failure. Gives Herdr the state of the agent,
	 * and Pi the agent's title, model and thinking level.
	 */
	#update(): void {
		const ui = this.#ui;

		if (ui === undefined || this.#closed) return;
		const { status, view, child } = this.#mirror;
		const open = status.kind === "open";
		const lines: string[] = [];

		if (view !== undefined && child !== undefined) {
			const chat = this.#chat ?? this.#showTranscript(ui, child);

			if (open) chat.apply(view);
			// A running bash card keeps its timer until it gets a final result, and no connection gives one now.
			else if (this.#open) chat.stopTimers();

			if (open) {
				for (const { mode, text } of queued(inboxOf(view))) {
					lines.push(
						this.#theme.fg("dim", `${mode === "steer" ? "Steer" : "Follow-up"}: ${text.split("\n")[0] ?? ""}`),
					);
				}
			}

			lines.push(usageLine(this.#theme, this.#ctx.modelRegistry, child, view));
		}

		this.#open = open;

		const working =
			status.kind === "reconnecting"
				? "Connecting again to the harness host..."
				: this.#mirror.busy && view !== undefined
					? statusText(liveOf(view)) || "Working..."
					: "";

		this.#status.show(ui, this.#theme, working, lines);

		if (status.kind === "failed" && !this.#failureShown) {
			this.#failureShown = true;

			// Without a transcript, the error takes the place of the connecting line.
			if (this.#chat === undefined) this.#frame.clear();
			this.#frame.addChild(this.#line("error", () => status.reason));
			this.#ctx.ui.notify(`harness: ${status.reason}`, "error");
		}

		this.#reporter?.report(this.#mirror.busy);

		if (child !== undefined) {
			if (open) this.#syncModel(child);
			const title = childTitle(child);

			if (this.#pi.getSessionName() !== title) this.#pi.setSessionName(title);
		}

		ui.requestRender();
	}

	/** Shows the transcript under its header, and makes the Herdr reporter, with the agent `first` of the first connection. */
	#showTranscript(ui: TUI, first: ChildInfo): ChatView {
		const chat = new ChatView(ui, first.cwd, (name, text) => this.#theme.fg(name, text));
		this.#chat = chat;
		chat.setExpanded(this.#expanded);
		this.showThinkingSetting();
		this.#frame.clear();
		this.#frame.addChild(this.#line("muted", () => this.#header(this.#mirror.child ?? first)));
		this.#frame.addChild(chat.transcript);
		const { project, handle } = this.#mirror.target;
		this.#reporter = agentReporter(process.env, childLabel(first), handle, project);

		return chat;
	}

	/** Gives the Pi session the model and the thinking level of the agent, so Pi's footer and `/model` show them. */
	#syncModel(child: ChildInfo): void {
		const model = this.#ctx.modelRegistry.find(child.provider, child.model);

		if (model !== undefined && !this.#hasAgentModel(child) && !this.#settingModel) {
			this.#settingModel = true;
			// Pi sets its own thinking level when it takes a model, so the agent's level follows once Pi has the model.
			void this.#pi.setModel(model).finally(() => {
				this.#settingModel = false;
				const current = this.#mirror.child;

				if (current !== undefined && !this.#closed) this.#syncThinking(current);
			});
		}

		this.#syncThinking(child);
	}

	/** Gives the Pi session the thinking level of the agent, once Pi has the agent's model. */
	#syncThinking(child: ChildInfo): void {
		if (this.#hasAgentModel(child) && this.#pi.getThinkingLevel() !== child.thinking) {
			this.#pi.setThinkingLevel(child.thinking);
		}
	}

	#hasAgentModel(child: ChildInfo): boolean {
		const model = this.#ctx.model;

		return model?.provider === child.provider && model.id === child.model;
	}

	#configure(change: MirrorConfigure): void {
		this.#mirror.configure(change).catch((cause: unknown) => {
			this.#notify(cause);
			const child = this.#mirror.child;

			// Pi goes back to the agent's model and level.
			if (child !== undefined && !this.#closed) this.#syncModel(child);
		});
	}

	#notify(cause: unknown): void {
		if (!this.#closed) this.#ctx.ui.notify(`harness: ${errorText(cause)}`, "error");
	}

	#header(child: ChildInfo): string {
		const theme = this.#theme;

		return [theme.bold(theme.fg("accent", "harness")), theme.fg("text", childTitle(child)), child.cwd].join(" │ ");
	}

	/** One line in the theme color `name`, colored at each render so that it follows a change of theme. */
	#line(name: ThemeColor, text: () => string): Component {
		return {
			render: (width) => [tui.truncateToWidth(` ${this.#theme.fg(name, text())}`, width)],
			invalidate: () => {},
		};
	}
}

/**
 * The editor of a mirror session. While the agent works, the interrupt key (Esc) aborts its turn and the follow-up key
 * (Alt+Enter) queues the text as a follow-up. Pi's editor handles every other key. After the key that hides thinking
 * (Ctrl+T), which Pi applies only to its own messages, the transcript of the agent follows the setting. After the key
 * that cycles the thinking level (Shift+Tab), the agent gets the level of Pi. Pi also changes its level when it takes a
 * model, so the mirror follows this key, not each change of Pi's level.
 */
class MirrorEditor extends coding.CustomEditor {
	readonly #keys: KeybindingsManager;
	readonly #attachment: Attachment;

	constructor(ui: TUI, theme: EditorTheme, keys: KeybindingsManager, attachment: Attachment) {
		super(ui, theme, keys);
		this.#keys = keys;
		this.#attachment = attachment;
	}

	handleInput(data: string): void {
		if (this.#attachment.busy && this.#keys.matches(data, "app.interrupt") && !this.isShowingAutocomplete()) {
			this.#attachment.abort(this);

			return;
		}

		if (this.#attachment.busy && this.#keys.matches(data, "app.message.followUp")) {
			const text = this.getExpandedText().trim();

			if (text !== "") {
				this.addToHistory(text);
				this.setText("");
				this.#attachment.send(text, true);
			}

			return;
		}

		super.handleInput(data);

		if (this.#keys.matches(data, "app.thinking.toggle")) this.#attachment.showThinkingSetting();

		if (this.#keys.matches(data, "app.thinking.cycle")) this.#attachment.cycledThinking();
	}
}

/** The status of the agent above the editor: Pi's working indicator while it works, then some lines. */
class StatusArea extends tui.Container {
	#loader: tui.Loader | undefined;

	/** Shows `status` with a spinner, or nothing when it is empty, then each of `lines`, cut to the width. */
	show(ui: TUI, theme: Theme, status: string, lines: readonly string[]): void {
		if (status === "") {
			this.dispose();
		} else if (this.#loader === undefined) {
			const spinner = (text: string) => theme.fg("accent", text);
			this.#loader = new tui.Loader(ui, spinner, (text) => theme.fg("muted", text), status);
		} else {
			this.#loader.setMessage(status);
		}

		this.clear();

		if (this.#loader !== undefined) this.addChild(this.#loader);

		for (const line of lines) this.addChild(new tui.TruncatedText(line, 1, 0));
	}

	dispose(): void {
		this.#loader?.stop();
		this.#loader = undefined;
	}
}

/**
 * The title of the agent, the tokens and the cost of its model requests and tool results, and the context of its last
 * answer that did not abort or fail, against the context window of its model, as Pi's footer shows them for its own
 * session.
 */
function usageLine(
	theme: Theme,
	models: ExtensionContext["modelRegistry"],
	child: ChildInfo,
	view: ConversationView,
): string {
	const totals = usageTotals(view);
	const last = lastAnswerUsage(view);
	const model = models.find(child.provider, child.model);
	const subscription = model !== undefined && models.isUsingOAuth(model);
	const usage: string[] = [];

	if (totals.input) usage.push(`↑${formatTokens(totals.input)}`);

	if (totals.output) usage.push(`↓${formatTokens(totals.output)}`);

	if (totals.cacheRead) usage.push(`R${formatTokens(totals.cacheRead)}`);

	if (totals.cacheWrite) usage.push(`W${formatTokens(totals.cacheWrite)}`);

	if (totals.cost || subscription) usage.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
	const parts = [childTitle(child)];

	if (usage.length > 0) parts.push(usage.join(" "));
	const contextWindow = model?.contextWindow ?? 0;

	if (contextWindow > 0) {
		const percent = last === undefined ? 0 : (coding.calculateContextTokens(last) / contextWindow) * 100;
		const context = `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
		parts.push(percent > 90 ? theme.fg("error", context) : percent > 70 ? theme.fg("warning", context) : context);
	}

	return theme.fg("dim", parts.join(" • "));
}

/** A token count as Pi's footer shows it: `950`, `1.2k`, `45k`, `1.5M`. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();

	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;

	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;

	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;

	return `${Math.round(count / 1_000_000)}M`;
}

/** The title of the agent of `target` before the host gives its name. */
function targetTitle(target: MirrorTarget): string {
	return target.handle === AGENT_HANDLE ? `${target.project} agent` : target.handle;
}

/** The newest mirror entry of `entries` with a valid target. */
function mirrorEntry(entries: readonly SessionEntry[]): MirrorEntry | undefined {
	for (const entry of entries.toReversed()) {
		if (entry.type === "custom" && entry.customType === MIRROR_ENTRY && isMirrorTarget(entry.data)) {
			return { id: entry.id, target: entry.data };
		}
	}

	return undefined;
}

/**
 * The mirror entry for `--harness <project>` and `--harness-child <handle>`, written in the session that Pi starts
 * with. Without a project, it is the project of `HARNESS_PROJECT` and Pi's working directory; without a child, the
 * project agent. It refuses a session with messages, such as one of `--continue`, because Pi's own agent answered there.
 */
function flagEntry(pi: ExtensionAPI, ctx: ExtensionContext): MirrorEntry | undefined {
	const project = stringFlag(pi, "harness");
	const child = stringFlag(pi, "harness-child");

	if (project === undefined && child === undefined) return undefined;

	if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) {
		ctx.ui.notify("harness: --harness needs a new session, not one with messages", "error");

		return undefined;
	}

	let target: MirrorTarget;

	try {
		target = {
			project: project ? checkProject(project) : resolveProject(process.env, ctx.cwd),
			handle: child || AGENT_HANDLE,
		};
	} catch (error) {
		ctx.ui.notify(`harness: ${errorText(error)}`, "error");

		return undefined;
	}

	pi.appendEntry(MIRROR_ENTRY, target);

	return mirrorEntry(ctx.sessionManager.getBranch());
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
async function pickProject(ctx: ExtensionCommandContext): Promise<string | undefined> {
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
function projectItems(prefix: string): AutocompleteItem[] | null {
	let names: string[];

	try {
		names = [...Object.keys(readProjects()), MAIN_PROJECT];
	} catch {
		return null;
	}

	const items = names.flatMap((name) => (name.startsWith(prefix) ? [{ value: name, label: name }] : []));

	return items.length > 0 ? items : null;
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
