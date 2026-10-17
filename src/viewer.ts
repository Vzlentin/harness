import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { apply } from "@earendil-works/chord/delta";
import { getSelectListTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type ConversationView, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import {
	type Component,
	Container,
	Editor,
	type KeybindingDefinitions,
	KeybindingsManager,
	Loader,
	matchesKey,
	ScrollView,
	setKeybindings,
	type Terminal,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import { ChatView, inboxOf, liveOf, queuedLines, queuedTexts, statusText } from "./chat.ts";
import { type Client, connect } from "./client.ts";
import { agentReporter } from "./herdr.ts";
import { type ChildInfo, childLabel, runDisplayName, type WatchLine } from "./protocol.ts";

// Pi gives its theme object only to extensions. Pi's cards color with the theme that `initTheme()` sets in this module,
// so the viewer loads the same module by its path to color its own lines the same way.
const piTheme = (await import(
	new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as { readonly theme: Theme };

/** pi-tui's keys and the one app key that Pi's tool cards name in their hints, with Pi's default. */
const KEYBINDINGS: KeybindingDefinitions = {
	...TUI_KEYBINDINGS,
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
};

export type AttachOptions = { readonly terminal: Terminal; readonly env: NodeJS.ProcessEnv };

/**
 * Shows the conversation of the child `handle` in `terminal` and sends what the user types to it. It starts the host
 * when none runs, and rejects before the terminal starts when the handle is unknown. It resolves with the exit code:
 * 0 after Ctrl+C or when the child is stopped, 1 when the host closes the connection. The child keeps running.
 */
export async function attach(handle: string, options: AttachOptions): Promise<number> {
	const client = await connect({ start: true });
	if (client === undefined) throw new Error("Could not connect to the harness host");
	let watched: Awaited<ReturnType<Client["watch"]>>;
	try {
		watched = await client.watch(handle);
	} catch (error) {
		client.close();
		throw error;
	}
	return new Viewer(handle, options, client, watched).start();
}

/** One line, cut to the width. */
class Line implements Component {
	text = "";
	render(width: number): string[] {
		return [truncateToWidth(this.text, width)];
	}
	invalidate(): void {}
}

/** The full-screen view of one attached child: header, transcript, status, editor and footer. */
class Viewer {
	private readonly tui: TuiAltScreen;
	private readonly chat: ChatView;
	private readonly scroll: ScrollView;
	private readonly header = new Line();
	private readonly working = new Container();
	private readonly queued = new Text("", 1, 0);
	private readonly notice = new Text("", 1, 0);
	private readonly editor: Editor;
	private readonly footer = new Line();
	private readonly keybindings: KeybindingsManager;
	private loader: Loader | undefined;
	private loaderText = "";
	private readonly reporter: ReturnType<typeof agentReporter>;
	private readonly exited: Promise<number>;
	readonly #exit: (code: number) => void;
	private readonly handle: string;
	private readonly terminal: Terminal;
	private readonly client: Client;
	private view: ConversationView;
	private readonly lines: AsyncIterable<WatchLine>;
	private child: ChildInfo;
	private done = false;

	constructor(handle: string, options: AttachOptions, client: Client, watched: Awaited<ReturnType<Client["watch"]>>) {
		this.handle = handle;
		this.terminal = options.terminal;
		this.client = client;
		this.view = watched.view;
		this.child = watched.child;
		this.lines = watched.lines;

		initTheme();
		this.keybindings = new KeybindingsManager(KEYBINDINGS);
		setKeybindings(this.keybindings);
		this.tui = new TuiAltScreen(this.terminal, false);
		this.chat = new ChatView(this.tui, this.child.cwd, (text) => this.color("muted", text));
		this.scroll = new ScrollView(this.chat.transcript, { follow: "end", primary: true });
		this.editor = new Editor(
			this.tui,
			{ borderColor: (text) => this.color("borderMuted", text), selectList: getSelectListTheme() },
			{ paddingX: 1 },
		);
		const status = new Container();
		status.addChild(this.working);
		status.addChild(this.queued);
		status.addChild(this.notice);
		this.tui.setLayoutRoot(
			new VStack([
				{ component: this.header, basis: "auto" },
				{ component: this.scroll, basis: 0, grow: 1, minSize: 3 },
				{ component: status, basis: "auto" },
				{ component: this.editor, basis: "auto", shrink: 1, minSize: 1 },
				{ component: this.footer, basis: "auto" },
			]),
		);
		this.tui.setFocus(this.editor);
		this.reporter = agentReporter(options.env, childLabel(this.child), handle);
		const { promise, resolve } = Promise.withResolvers<number>();
		this.exited = promise;
		this.#exit = resolve;

		this.editor.onSubmit = (text) => this.send(text, false);
		this.tui.addInputListener((data) => this.handleKey(data));
	}

	/** Starts the terminal and the watch, and resolves with the exit code. */
	start(): Promise<number> {
		this.tui.start();
		this.render();
		this.reporter.report(this.child.state === "busy");
		void this.follow(this.lines);
		return this.exited;
	}

	private color(name: Parameters<Theme["fg"]>[0], text: string): string {
		return piTheme.theme.fg(name, text);
	}

	private render(): void {
		this.chat.apply(this.view);
		const child = this.child;
		const separator = this.color("borderMuted", "  │  ");
		const state =
			child.state === "busy"
				? this.color("warning", "◉ busy")
				: child.state === "idle"
					? this.color("success", "● idle")
					: this.color("error", "⊗ error");
		this.header.text = ` ${[
			piTheme.theme.bold(this.color("accent", "harness")),
			runDisplayName(child),
			this.color("muted", tildePath(child.cwd)),
			state,
		].join(separator)}`;
		this.syncLoader(statusText(liveOf(this.view)));
		this.queued.setText(
			queuedLines(inboxOf(this.view))
				.map((line) => this.color("dim", line))
				.join("\n"),
		);
		const usage = totalUsage(this.view.docs[UsageDoc.definition.kind] as UsageState | undefined);
		this.footer.text = ` ${this.color(
			"muted",
			[
				`${child.provider}/${child.model} · ${child.thinking}`,
				`${compactCount(usage.tokens)} tok $${usage.cost.toFixed(3)}`,
				"ctrl+o expand",
				"ctrl+c exit",
			].join(" │ "),
		)}`;
		this.tui.requestRender();
	}

	/** Shows Pi's working indicator with `text`, or removes it when `text` is empty. */
	private syncLoader(text: string): void {
		if (text === this.loaderText) return;
		this.loaderText = text;
		this.loader?.stop();
		this.loader = undefined;
		this.working.clear();
		if (text === "") return;
		this.loader = new Loader(
			this.tui,
			(value) => this.color("accent", value),
			(value) => this.color("muted", value),
			text,
		);
		this.working.addChild(this.loader);
	}

	private handleKey(data: string): { consume: true } | undefined {
		if (matchesKey(data, "ctrl+c")) {
			void this.finish(0, `${runDisplayName(this.child)} keeps running. Reattach: harness attach ${this.handle}`);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			// An idle child has no turn to abort.
			if (this.child.state === "busy") this.abort();
			return { consume: true };
		}
		if (matchesKey(data, "alt+enter")) {
			const text = this.editor.getText();
			this.editor.setText("");
			this.send(text, true);
			return { consume: true };
		}
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.chat.toggleExpanded();
			this.tui.requestRender();
			return { consume: true };
		}
		const page = Math.max(1, this.scroll.viewportHeight - 1);
		const scroll = matchesKey(data, "shift+up")
			? -1
			: matchesKey(data, "shift+down")
				? 1
				: matchesKey(data, "shift+pageUp")
					? -page
					: matchesKey(data, "shift+pageDown")
						? page
						: 0;
		if (scroll !== 0) {
			this.scroll.scrollBy(scroll);
			this.tui.requestRender();
			return { consume: true };
		}
		return undefined;
	}

	/** Aborts the turn. The host withdraws the queued messages, so they go back to the editor, steers first. */
	private abort(): void {
		const queued = queuedTexts(inboxOf(this.view));
		this.client.request({ type: "abort", handle: this.handle }).then(() => {
			this.notice.setText("");
			const text = [...queued, this.editor.getText()].filter((part) => part.trim() !== "").join("\n\n");
			if (text !== this.editor.getText()) this.editor.setText(text);
			this.tui.requestRender();
		}, this.showError);
	}

	private send(message: string, followUp: boolean): void {
		if (message.trim() === "") return;
		this.editor.addToHistory(message);
		const request = {
			type: "input",
			requestId: randomUUID(),
			handle: this.handle,
			message,
			followUp,
		} as const;
		this.client.request(request).then(() => this.notice.setText(""), this.showError);
	}

	/** Shows each event of the watch, and finishes when the connection closes. */
	private async follow(lines: AsyncIterable<WatchLine>): Promise<void> {
		for await (const line of lines) this.onLine(line);
		await this.finish(1, "The harness host closed the connection");
	}

	private onLine(line: WatchLine): void {
		if (this.done) return;
		if (line.stopped) {
			void this.finish(0, `${runDisplayName(this.child)} was stopped`);
			return;
		}
		this.view = apply(this.view, line.ops);
		this.child = line.child;
		this.render();
		this.reporter.report(this.child.state === "busy");
	}

	private async finish(code: number, message?: string): Promise<void> {
		if (this.done) return;
		this.done = true;
		this.loader?.stop();
		this.chat.dispose();
		this.tui.stop();
		if (message !== undefined) this.terminal.write(`${message}\n`);
		this.client.close();
		await this.reporter.release();
		this.#exit(code);
	}

	private readonly showError = (error: unknown): void => {
		this.notice.setText(this.color("error", `Error: ${error instanceof Error ? error.message : String(error)}`));
		this.tui.requestRender();
	};
}

/** The tokens and the cost of every model request of the conversation. */
function totalUsage(usage: UsageState | undefined): { tokens: number; cost: number } {
	let tokens = 0;
	let cost = 0;
	for (const model of Object.values(usage?.models ?? {})) {
		tokens += model.totalTokens;
		cost += model.cost.total;
	}
	return { tokens, cost };
}

function compactCount(count: number): string {
	return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

function tildePath(path: string): string {
	const home = homedir();
	return home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}
