/**
 * Mirror sessions: a Pi session that shows a child or the agent of a harness project in Pi's own chat, and sends what
 * the user types to it. The agent runs in the host of the project; the session keeps only its target, in one custom
 * entry. `/harness [project]` opens one in a new session, and `pi --harness <project> [--harness-child <handle>]` in the
 * session that Pi starts with.
 */

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
import type { AutocompleteItem, Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
import { type ChatKit, ChatView } from "../dist/chat.js";
import { type AgentReporter, agentReporter } from "../dist/herdr.js";
import { isMirrorTarget, MIRROR_ENTRY, Mirror, type MirrorConfigure, type MirrorTarget } from "../dist/mirror.js";
import { checkProject, MAIN_PROJECT, projectDir, readProjects, resolveProject } from "../dist/projects.js";
import { AGENT_HANDLE, type ChildInfo, childLabel, childTitle, runDisplayName } from "../dist/protocol.js";
import { inboxOf, liveOf, queued, statusText } from "../dist/view-state.js";
import { type FooterState, MirrorFooter, tildePath } from "./footer.ts";

/** The key of the status widget above the editor. */
const WIDGET = "harness-mirror";

/** The waits before the tries to connect again after the host closed the connection. */
const RECONNECT_DELAYS_MS = [0, 2000, 5000];

/** A connection that was opened again and ends sooner than this is not opened again. */
const SHORT_CONNECTION_MS = 10_000;

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

	// The agent of the host answers in a mirror session, so the input goes there and Pi's own agent never runs.
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

	pi.on("thinking_level_select", (event) => attached?.selectThinking(event.level));
}

/**
 * The mirror of one Pi session: the frame of its entry in Pi's chat, which holds the transcript, the status above the
 * editor, an editor whose interrupt and follow-up keys act on the agent while it works, and the connection to the host.
 */
class Attachment {
	readonly entryId: string;
	// After a session switch, `#pi` and `#ctx` are stale and throw, so only code that checks `#closed` uses them. The
	// components that Pi draws use `#theme` instead.
	readonly #pi: ExtensionAPI;
	readonly #ctx: ExtensionContext;
	#theme: Theme;
	readonly #target: MirrorTarget;
	readonly #frame: tui.Container;
	readonly #status = new StatusArea();
	/** Messages that the user sent before the connection was open. They go out once it is. */
	readonly #pending: { readonly text: string; readonly followUp: boolean }[] = [];
	/** Stops the wait for a host that starts when the attachment closes. */
	readonly #abort = new AbortController();
	#ui: TUI | undefined;
	#mirror: Mirror | undefined;
	#chat: ChatView | undefined;
	/** The agent and its conversation for the footer, from the last connection, also while there is none. */
	#shown: FooterState | undefined;
	/** The state of the agent for Herdr, made at the first connection. */
	#reporter: AgentReporter | undefined;
	/** Why the mirror has no connection, after a failed open or the end of the watch. */
	#failure: string | undefined;
	/** True while Pi sets the agent's model: `setModel` is async, and the view changes often while the agent works. */
	#settingModel = false;
	#expanded = false;
	#closed = false;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, entry: MirrorEntry, frame: tui.Container) {
		this.entryId = entry.id;
		this.#pi = pi;
		this.#ctx = ctx;
		this.#theme = ctx.ui.theme;
		this.#target = entry.target;
		this.#frame = frame;
		this.#frame.clear();
		this.#frame.addChild(this.#line("muted", () => `Connecting to the ${this.#title()}...`));
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
		void this.#run();
	}

	get busy(): boolean {
		return this.#mirror?.busy ?? false;
	}

	/** Sends `text` to the agent: a new turn when it is idle, else a steer, or a follow-up with `followUp`. */
	send(text: string, followUp: boolean): void {
		const mirror = this.#mirror;

		if (mirror !== undefined) {
			mirror.send(text, followUp).then(
				() => this.#update(),
				(cause: unknown) => this.#notify(cause),
			);

			return;
		}

		if (this.#failure === undefined) {
			this.#pending.push({ text, followUp });

			return;
		}

		if (this.#closed) return;
		// The text goes back to the editor, so it is not lost.
		this.#ctx.ui.setEditorText(text);
		this.#ctx.ui.notify(`harness: not sent: ${this.#failure}`, "error");
	}

	/** Aborts the agent's turn. The queued messages that the host withdraws go back to `editor`, steers first. */
	abort(editor: Pick<tui.Editor, "getText" | "setText">): void {
		this.#mirror?.abort().then(
			(texts) => {
				if (this.#closed) return;
				const text = [...texts, editor.getText()].filter((part) => part.trim() !== "").join("\n\n");

				if (text !== editor.getText()) editor.setText(text);
				this.#update();
			},
			(cause: unknown) => this.#notify(cause),
		);
	}

	/** Gives the agent the model that the user selected in Pi. */
	selectModel(provider: string, model: string): void {
		const child = this.#mirror?.child;

		if (child === undefined || (child.provider === provider && child.model === model)) return;
		this.#configure({ provider, model });
	}

	/** Gives the agent the thinking level that the user selected in Pi, once Pi has the agent's model. */
	selectThinking(thinking: ChildInfo["thinking"]): void {
		const child = this.#mirror?.child;

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

	/** Closes the connection and gives Pi back its editor and footer. The agent keeps running in the host. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#abort.abort();
		this.#mirror?.close();
		this.#chat?.stopTimers();
		this.#status.dispose();
		this.#ctx.ui.setWidget(WIDGET, undefined);
		this.#ctx.ui.setEditorComponent(undefined);
		this.#ctx.ui.setFooter(undefined);
		void this.#reporter?.release();
	}

	/**
	 * Opens the connection, and opens it again when the host closes it, which starts a new host. When the host closes a
	 * connection that was opened again within `SHORT_CONNECTION_MS`, the mirror fails, so a host that fails soon after
	 * each start does not start again and again.
	 */
	async #run(): Promise<void> {
		let mirror = await this.#connect([0], "");
		let again = false;

		while (mirror !== undefined) {
			const opened = Date.now();

			if (!this.#attach(mirror)) return;
			const end = await mirror.ended;

			if (this.#closed) return;
			this.#mirror = undefined;
			this.#chat?.stopTimers();

			if (end === "stopped") {
				this.#fail(`${runDisplayName(mirror.child)} was stopped`);

				return;
			}

			if (again && Date.now() - opened < SHORT_CONNECTION_MS) {
				this.#fail("The harness host closed the connection. Run /reload to attach again");

				return;
			}

			again = true;
			this.#status.show(this.#ui, this.#theme, "Connecting again to the harness host...", []);
			this.#ui?.requestRender();
			mirror = await this.#connect(
				RECONNECT_DELAYS_MS,
				"The harness host closed the connection. Connecting again failed: ",
			);
		}
	}

	/**
	 * A connection to the host, after one try at each delay of `delays`. It is undefined after `close()`, and when all
	 * tries fail; the mirror then fails with `context` and the error of the last try.
	 */
	async #connect(delays: readonly number[], context: string): Promise<Mirror | undefined> {
		let failure = "";

		for (const delay of delays) {
			if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));

			if (this.#closed) return undefined;

			try {
				const mirror = await Mirror.open(this.#target, () => this.#update(), this.#abort.signal);

				if (!this.#closed) return mirror;
				mirror.close();

				return undefined;
			} catch (error) {
				failure = errorText(error);
			}
		}

		this.#fail(`${context}${failure}`);

		return undefined;
	}

	/**
	 * Shows `mirror`: the first connection makes the transcript and the footer, a later one updates them. It is false
	 * when Pi gave no terminal UI; the mirror then fails.
	 */
	#attach(mirror: Mirror): boolean {
		const ui = this.#ui;

		if (ui === undefined) {
			mirror.close();
			this.#fail("Pi gave no terminal UI");

			return false;
		}

		this.#mirror = mirror;

		if (this.#chat === undefined) {
			this.#chat = new ChatView(this.#kit(), ui, mirror.child.cwd);
			this.#chat.setExpanded(this.#expanded);
			this.showThinkingSetting();
			this.#frame.clear();
			this.#frame.addChild(this.#line("muted", () => this.#header(this.#shown?.child ?? mirror.child)));
			this.#frame.addChild(this.#chat.transcript);
			const { project, handle } = this.#target;
			this.#reporter = agentReporter(process.env, childLabel(mirror.child), handle, project);
			const ctx = this.#ctx;
			const shown = () => this.#shown ?? { child: mirror.child, view: mirror.view };
			ctx.ui.setFooter((_ui, theme, data) => new MirrorFooter(theme, data, ctx.modelRegistry, ctx.cwd, shown));
		}

		this.#update();

		for (const { text, followUp } of this.#pending.splice(0)) this.send(text, followUp);

		return true;
	}

	/** Shows the view and the state of the agent, and gives Pi the agent's model and thinking level. */
	#update(): void {
		const mirror = this.#mirror;
		const ui = this.#ui;

		if (mirror === undefined || ui === undefined || this.#closed) return;
		this.#shown = { child: mirror.child, view: mirror.view };
		this.#chat?.apply(mirror.view);

		const queue = queued(inboxOf(mirror.view)).map(
			({ mode, text }) => `${mode === "steer" ? "Steer" : "Follow-up"}: ${text.split("\n")[0] ?? ""}`,
		);

		const status = mirror.busy ? statusText(liveOf(mirror.view)) || "Working..." : "";
		this.#status.show(ui, this.#theme, status, queue);
		this.#syncModel(mirror.child);
		this.#reporter?.report(mirror.busy);
		const title = childTitle(mirror.child);

		if (this.#pi.getSessionName() !== title) this.#pi.setSessionName(title);
		ui.requestRender();
	}

	/** Gives the Pi session the model and the thinking level of the agent, so Pi's footer and `/model` show them. */
	#syncModel(child: ChildInfo): void {
		const model = this.#ctx.modelRegistry.find(child.provider, child.model);

		if (model !== undefined && !this.#hasAgentModel(child) && !this.#settingModel) {
			this.#settingModel = true;
			void this.#pi.setModel(model).finally(() => {
				this.#settingModel = false;
			});
		}

		if (this.#hasAgentModel(child) && this.#pi.getThinkingLevel() !== child.thinking) {
			this.#pi.setThinkingLevel(child.thinking);
		}
	}

	#hasAgentModel(child: ChildInfo): boolean {
		const model = this.#ctx.model;

		return model?.provider === child.provider && model.id === child.model;
	}

	#configure(change: MirrorConfigure): void {
		this.#mirror?.configure(change).then(
			() => this.#update(),
			(cause: unknown) => {
				this.#notify(cause);

				// Pi goes back to the agent's model and level.
				if (this.#mirror !== undefined && !this.#closed) this.#syncModel(this.#mirror.child);
			},
		);
	}

	#fail(reason: string): void {
		if (this.#closed) return;
		this.#failure = reason;
		// The messages that waited for the connection go back to the editor, so they are not lost.
		const texts = this.#pending.splice(0).map(({ text }) => text);

		if (texts.length > 0) {
			const editor = this.#ctx.ui.getEditorText();
			this.#ctx.ui.setEditorText([...texts, editor].filter((part) => part.trim() !== "").join("\n\n"));
		}

		this.#status.show(this.#ui, this.#theme, "", []);
		this.#reporter?.report(false);

		// Without a transcript, the error takes the place of the connecting line.
		if (this.#chat === undefined) this.#frame.clear();
		this.#frame.addChild(this.#line("error", () => reason));
		this.#ctx.ui.notify(`harness: ${reason}`, "error");
		this.#ui?.requestRender();
	}

	#notify(cause: unknown): void {
		if (!this.#closed) this.#ctx.ui.notify(`harness: ${errorText(cause)}`, "error");
	}

	#title(): string {
		const { project, handle } = this.#target;

		return handle === AGENT_HANDLE ? `${project} agent` : handle;
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

	#kit(): ChatKit {
		return { coding, tui, color: (name, text) => this.#theme.fg(name, text) };
	}
}

/**
 * The editor of a mirror session. While the agent works, the interrupt key (Esc) aborts its turn and the follow-up key
 * (Alt+Enter) queues the text as a follow-up. Pi's editor handles every other key. After the thinking key (Ctrl+T),
 * which Pi applies only to its own messages, the transcript of the agent follows the setting.
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
	}
}

/** The status of the agent above the editor: Pi's working indicator while it works, then its queued messages. */
class StatusArea extends tui.Container {
	#loader: tui.Loader | undefined;

	/** Shows `status` with a spinner, or nothing when it is empty, then one line for each item of `queue`. */
	show(ui: TUI | undefined, theme: Theme, status: string, queue: readonly string[]): void {
		if (status === "" || ui === undefined) {
			this.dispose();
		} else if (this.#loader === undefined) {
			const spinner = (text: string) => theme.fg("accent", text);
			this.#loader = new tui.Loader(ui, spinner, (text) => theme.fg("muted", text), status);
		} else {
			this.#loader.setMessage(status);
		}

		this.clear();

		if (this.#loader !== undefined) this.addChild(this.#loader);

		for (const line of queue) this.addChild(new tui.Text(theme.fg("dim", line), 1, 0));
	}

	dispose(): void {
		this.#loader?.stop();
		this.#loader = undefined;
	}
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
