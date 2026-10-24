/**
 * The mirror of one Pi session: the frame of its entry in Pi's chat, which holds the transcript, the status above the
 * editor, and an editor whose interrupt and follow-up keys act on the agent while it works. The connection to the host
 * is the `Mirror`, and the model and thinking level of the session are the `ModelSync`.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import * as coding from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
import { type AgentReporter, agentReporter } from "../dist/herdr.js";
import { Mirror, type MirrorStatus, type MirrorTarget, targetTitle } from "../dist/mirror.js";
import { type ChildInfo, childLabel, childTitle, errorMessage } from "../dist/protocol.js";
import { inboxOf, liveOf, queued, statusText } from "../dist/view-state.js";
import { ChatView } from "./chat.ts";
import { ModelSync } from "./model-sync.ts";
import { ProgramStatusReport } from "./program-status.ts";
import { usageLine } from "./usage-line.ts";

/** The key of the status widget above the editor. */
const WIDGET = "harness-mirror";

export class Attachment {
	readonly entryId: string;
	readonly models: ModelSync;
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
	/** The state of the agent for the terminal, made with the TUI. */
	#programStatus: ProgramStatusReport | undefined;
	#expanded = false;
	#closed = false;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, entryId: string, target: MirrorTarget, frame: tui.Container) {
		this.entryId = entryId;
		this.#pi = pi;
		this.#ctx = ctx;
		this.#theme = ctx.ui.theme;
		this.#frame = frame;
		this.#frame.clear();
		this.#frame.addChild(this.#line("muted", () => `Connecting to the ${targetTitle(target)}...`));
		// Pi calls the factory at once, which gives the TUI that the tool cards need.
		ctx.ui.setWidget(
			WIDGET,
			(ui, theme) => {
				this.#ui = ui;
				this.#theme = theme;
				this.#programStatus ??= new ProgramStatusReport(ui.terminal);

				return this.#status;
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setEditorComponent((ui, theme, keybindings) => new MirrorEditor(ui, theme, keybindings, this));
		this.#mirror = new Mirror(target, (previous) => this.#update(previous));
		this.#programStatus?.update(this.#mirror);
		this.models = new ModelSync(pi, ctx, this.#mirror, (cause) => this.#notify(cause));
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
			this.#ctx.ui.notify(`harness: not sent: ${errorMessage(cause)}`, "error");
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
		this.models.close();
		this.#mirror.close();
		this.#chat?.stopTimers();
		this.#status.dispose();
		this.#ctx.ui.setWidget(WIDGET, undefined);
		this.#ctx.ui.setEditorComponent(undefined);
		void this.#reporter?.release();
		this.#programStatus?.leave(this.#mirror);
	}

	/** Shows each change of the mirror, whose status was `previous` before it. */
	#update(previous: MirrorStatus): void {
		const ui = this.#ui;

		if (ui === undefined || this.#closed) return;
		const { status, view, child } = this.#mirror;

		if (view !== undefined && child !== undefined) this.#showTranscript(ui, view, child, previous);
		this.#showStatus(ui, view, child);

		if (status.kind === "failed" && previous.kind !== "failed") this.#showFailure(status.reason);
		this.#reporter?.report(this.#mirror.busy);
		this.#programStatus?.update(this.#mirror);

		if (child !== undefined) this.#followAgent(child);
		ui.requestRender();
	}

	/**
	 * Shows the transcript under its header, and makes the Herdr reporter at the first connection. It applies `view` only
	 * on an open connection.
	 */
	#showTranscript(ui: TUI, view: ConversationView, child: ChildInfo, previous: MirrorStatus): void {
		const chat = this.#chat ?? this.#startTranscript(ui, child);

		if (this.#mirror.status.kind === "open") chat.apply(view);
		// A running bash card keeps its timer until it gets a final result, and no connection gives one now.
		else if (previous.kind === "open") chat.stopTimers();
	}

	#startTranscript(ui: TUI, first: ChildInfo): ChatView {
		const chat = new ChatView(ui, first.cwd, (name, text) => this.#theme.fg(name, text));
		this.#chat = chat;
		chat.setExpanded(this.#expanded);
		this.showThinkingSetting();
		this.#frame.clear();
		this.#frame.addChild(this.#line("muted", () => this.#header(this.#mirror.child ?? first)));
		this.#frame.addChild(chat.transcript);
		this.#reporter = agentReporter(process.env, childLabel(first), this.#mirror.target);

		return chat;
	}

	/** Shows above the editor what the agent does, its queued messages and its usage line. */
	#showStatus(ui: TUI, view: ConversationView | undefined, child: ChildInfo | undefined): void {
		const { status, busy } = this.#mirror;
		const lines: string[] = [];

		if (view !== undefined && status.kind === "open") {
			for (const { mode, text } of queued(inboxOf(view))) {
				lines.push(this.#theme.fg("dim", `${mode === "steer" ? "Steer" : "Follow-up"}: ${text.split("\n")[0] ?? ""}`));
			}
		}

		if (view !== undefined && child !== undefined) {
			lines.push(usageLine(this.#theme, this.#ctx.modelRegistry, child, view));
		}

		const working =
			status.kind === "reconnecting"
				? "Connecting again to the harness host..."
				: busy && view !== undefined
					? statusText(liveOf(view)) || "Working..."
					: "";

		this.#status.show(ui, this.#theme, working, lines);
	}

	#showFailure(reason: string): void {
		// Without a transcript, the error takes the place of the connecting line.
		if (this.#chat === undefined) this.#frame.clear();
		this.#frame.addChild(this.#line("error", () => reason));
		this.#ctx.ui.notify(`harness: ${reason}`, "error");
	}

	/** Gives Pi the agent's title, and on an open connection its model and thinking level. */
	#followAgent(child: ChildInfo): void {
		if (this.#mirror.status.kind === "open") this.models.fromAgent(child);
		const title = childTitle(child);

		if (this.#pi.getSessionName() !== title) this.#pi.setSessionName(title);
	}

	#notify(cause: unknown): void {
		if (!this.#closed) this.#ctx.ui.notify(`harness: ${errorMessage(cause)}`, "error");
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
 * that cycles the thinking level (Shift+Tab), the agent gets the level of Pi.
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

		if (this.#keys.matches(data, "app.thinking.cycle")) this.#attachment.models.piCycled();
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
