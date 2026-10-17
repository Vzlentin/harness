import { randomUUID } from "node:crypto";
import { apply } from "@earendil-works/chord/delta";
import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import {
	Container,
	Editor,
	type Keybinding,
	type KeybindingDefinitions,
	KeybindingsManager,
	Loader,
	type OverlayHandle,
	ScrollView,
	setKeybindings,
	type Terminal,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { ChatView } from "./chat.ts";
import { footerText, headerText, Line } from "./chrome.ts";
import { type Client, connect } from "./client.ts";
import { agentReporter } from "./herdr.ts";
import { ModelPicker } from "./picker.ts";
import {
	AGENT_HANDLE,
	type ChildInfo,
	childLabel,
	type ModelInfo,
	type Request,
	runDisplayName,
	type WatchLine,
} from "./protocol.ts";
import { color } from "./theme.ts";
import { inboxOf, liveOf, queued, statusText } from "./view-state.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.scroll.lineUp": true;
		"app.scroll.lineDown": true;
		"app.scroll.pageUp": true;
		"app.scroll.pageDown": true;
	}
}

/** pi-tui's keys and the viewer's keys, with Pi's ids and defaults where Pi has the same action. */
const KEYBINDINGS: KeybindingDefinitions = {
	...TUI_KEYBINDINGS,
	"app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "Select model" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.interrupt": { defaultKeys: "escape", description: "Abort the turn" },
	"app.message.followUp": { defaultKeys: "alt+enter", description: "Queue a follow-up message" },
	"app.exit": { defaultKeys: "ctrl+c", description: "Detach" },
	"app.scroll.lineUp": { defaultKeys: "shift+up", description: "Scroll up one line" },
	"app.scroll.lineDown": { defaultKeys: "shift+down", description: "Scroll down one line" },
	"app.scroll.pageUp": { defaultKeys: "shift+pageUp", description: "Scroll up one page" },
	"app.scroll.pageDown": { defaultKeys: "shift+pageDown", description: "Scroll down one page" },
};

export type AttachOptions = { readonly terminal: Terminal; readonly env: NodeJS.ProcessEnv };

/**
 * Shows the conversation of the child `handle`, or of the project agent for `AGENT_HANDLE`, in `terminal` and sends
 * what the user types to it. It starts the host when none runs, and rejects before the terminal starts when the handle
 * is unknown. It resolves with the exit code: 0 after Ctrl+C or when the child is stopped, 1 when the host closes the
 * connection. The child keeps running.
 */
export async function attach(handle: string, options: AttachOptions): Promise<number> {
	const client = await connect({ start: true });
	if (client === undefined) throw new Error("Could not connect to the harness host");
	let watched: Awaited<ReturnType<Client["watch"]>>;
	let models: readonly ModelInfo[];
	try {
		[watched, models] = await Promise.all([client.watch(handle), client.request({ type: "models" })]);
	} catch (error) {
		client.close();
		throw error;
	}
	return new Viewer(handle, options, client, watched, models).start();
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
	private models: readonly ModelInfo[];
	private picker: OverlayHandle | undefined;
	private done = false;
	/** The viewer's keys. A row with a hint shows in the footer, with its first key. */
	private readonly keys: readonly { readonly id: Keybinding; readonly action: () => void; readonly hint?: string }[] = [
		{ id: "app.thinking.cycle", action: () => this.cycleThinking(), hint: "thinking" },
		{ id: "app.model.select", action: () => this.pickModel(), hint: "model" },
		{ id: "app.tools.expand", action: () => this.toggleExpanded(), hint: "expand" },
		{
			id: "app.exit",
			action: () =>
				void this.finish(
					0,
					this.handle === AGENT_HANDLE
						? `${childLabel(this.child)} keeps running. Reattach: harness ${this.client.project}`
						: `${runDisplayName(this.child)} keeps running. Reattach: harness attach ${this.handle}`,
				),
			hint: "exit",
		},
		{
			id: "app.interrupt",
			// An idle child has no turn to abort.
			action: () => {
				if (this.child.state === "busy") this.abort();
			},
		},
		{ id: "app.message.followUp", action: () => this.followUp() },
		{ id: "app.scroll.lineUp", action: () => this.scrollBy(-1) },
		{ id: "app.scroll.lineDown", action: () => this.scrollBy(1) },
		{ id: "app.scroll.pageUp", action: () => this.scrollBy(-this.pageSize()) },
		{ id: "app.scroll.pageDown", action: () => this.scrollBy(this.pageSize()) },
	];

	constructor(
		handle: string,
		options: AttachOptions,
		client: Client,
		watched: Awaited<ReturnType<Client["watch"]>>,
		models: readonly ModelInfo[],
	) {
		this.handle = handle;
		this.models = models;
		this.terminal = options.terminal;
		this.client = client;
		this.view = watched.view;
		this.child = watched.child;
		this.lines = watched.lines;

		initTheme();
		this.keybindings = new KeybindingsManager(KEYBINDINGS);
		setKeybindings(this.keybindings);
		this.tui = new TuiAltScreen(this.terminal, false);
		this.chat = new ChatView(this.tui, this.child.cwd);
		this.scroll = new ScrollView(this.chat.transcript, { follow: "end", primary: true });
		this.editor = new Editor(
			this.tui,
			{ borderColor: (text) => color("borderMuted", text), selectList: getSelectListTheme() },
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
		this.footer.style = (text) => color("dim", text);
		this.footer.hints = this.keys.flatMap(({ id, hint }) =>
			hint === undefined ? [] : [`${this.keybindings.getKeys(id)[0]} ${hint}`],
		);
		this.tui.setFocus(this.editor);
		this.reporter = agentReporter(options.env, childLabel(this.child), handle, client.project);
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

	private render(): void {
		this.chat.apply(this.view);
		// The agent's name already says what it is; a child's shows its handle too.
		this.header.text = headerText(
			this.child,
			this.handle === AGENT_HANDLE ? childLabel(this.child) : runDisplayName(this.child),
		);
		this.syncLoader(statusText(liveOf(this.view)));
		this.queued.setText(
			queued(inboxOf(this.view))
				.map(({ mode, text }) =>
					color("dim", `${mode === "steer" ? "Steer" : "Follow-up"}: ${text.split("\n")[0] ?? ""}`),
				)
				.join("\n"),
		);
		this.footer.text = footerText(this.child, this.view, this.modelInfo()?.contextWindow);
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
			(value) => color("accent", value),
			(value) => color("muted", value),
			text,
		);
		this.working.addChild(this.loader);
	}

	private handleKey(data: string): { consume: true } | undefined {
		// The model picker gets every key while it shows.
		if (this.picker !== undefined) return undefined;
		const key = this.keys.find(({ id }) => this.keybindings.matches(data, id));
		if (key === undefined) return undefined;
		key.action();
		return { consume: true };
	}

	private toggleExpanded(): void {
		this.chat.toggleExpanded();
		this.tui.requestRender();
	}

	/** Alt+Enter: queues the editor's text as a follow-up. */
	private followUp(): void {
		const text = this.editor.getText();
		this.editor.setText("");
		this.send(text, true);
	}

	private pageSize(): number {
		return Math.max(1, this.scroll.viewportHeight - 1);
	}

	private scrollBy(lines: number): void {
		this.scroll.scrollBy(lines);
		this.tui.requestRender();
	}

	private modelInfo(): ModelInfo | undefined {
		return this.models.find((model) => model.provider === this.child.provider && model.id === this.child.model);
	}

	/** Shift+Tab: the next thinking level of the child's model, after the last one `off` again. */
	private cycleThinking(): void {
		const levels = this.modelInfo()?.thinkingLevels ?? [];
		const thinking = levels[(levels.indexOf(this.child.thinking) + 1) % levels.length];
		if (levels.length < 2 || thinking === undefined) {
			this.showNotice(`${this.child.provider}/${this.child.model} has no thinking levels`);
			return;
		}
		this.configure({ thinking });
	}

	/** Ctrl+L: a list of the models with a login, as the host has them now. Typing filters it, Enter picks, Esc closes. */
	private pickModel(): void {
		this.client.request({ type: "models" }).then((models) => {
			this.models = models;
			if (this.picker !== undefined) return;
			if (models.length === 0) {
				this.showNotice("The host has no models with a login");
				return;
			}
			const picker = new ModelPicker(
				models,
				this.modelInfo(),
				(text) => color("borderMuted", text),
				(model) => {
					this.closePicker();
					this.configure({ provider: model.provider, model: model.id });
				},
				() => this.closePicker(),
			);
			this.picker = this.tui.showOverlay(picker, { width: "70%", minWidth: 40, maxHeight: "60%" });
			this.tui.setFocus(picker);
			this.tui.requestRender();
		}, this.showError);
	}

	private closePicker(): void {
		this.picker?.hide();
		this.picker = undefined;
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}

	private configure(change: Omit<Extract<Request, { type: "configure" }>, "type" | "handle">): void {
		this.client.request({ type: "configure", handle: this.handle, ...change }).then((child) => {
			this.child = child;
			this.notice.setText("");
			this.render();
		}, this.showError);
	}

	private showNotice(text: string): void {
		this.notice.setText(color("muted", text));
		this.tui.requestRender();
	}

	/** Aborts the turn. The host withdraws the queued messages, so they go back to the editor, steers first. */
	private abort(): void {
		const inputs = queued(inboxOf(this.view));
		const texts = [
			...inputs.filter((input) => input.mode === "steer"),
			...inputs.filter((input) => input.mode === "followUp"),
		].map((input) => input.text);
		this.client.request({ type: "abort", handle: this.handle }).then(() => {
			this.notice.setText("");
			const text = [...texts, this.editor.getText()].filter((part) => part.trim() !== "").join("\n\n");
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
		this.chat.stopTimers();
		this.tui.stop();
		if (message !== undefined) this.terminal.write(`${message}\n`);
		this.client.close();
		await this.reporter.release();
		this.#exit(code);
	}

	private readonly showError = (error: unknown): void => {
		this.notice.setText(color("error", `Error: ${error instanceof Error ? error.message : String(error)}`));
		this.tui.requestRender();
	};
}
