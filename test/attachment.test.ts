import { stripVTControlCharacters } from "node:util";
import * as coding from "@earendil-works/pi-coding-agent";
import type {
	ConversationId,
	ConversationView,
	EntryId,
	EntryRecord,
	LiveState,
	TaskId,
} from "@earendil-works/pi-durable";
import { type Component, KeybindingsManager, type TUI, TUI_KEYBINDINGS, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { ChatView } from "../pi/chat.ts";
import { registerMirror } from "../pi/mirror.ts";
import { PolledWidget } from "../pi/polled-widget.ts";
import * as mirror from "../src/client/mirror.ts";
import {
	MIRROR_ENTRY,
	type MirrorStatus,
	type MirrorTarget,
	PossiblySentError,
	toMirrorEntry,
} from "../src/client/mirror.ts";
import * as viewState from "../src/client/view-state.ts";
import * as protocol from "../src/protocol/index.ts";
import * as projects from "../src/protocol/projects.ts";
import type { ChildInfo } from "../src/protocol/requests.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { TODO_LIST_KIND, type Todo } from "../src/protocol/todo.ts";
import { FakeTerminal, until } from "./helpers.ts";

const AGENT: MirrorTarget = { project: "main", target: { kind: "agent" } };

const CHILD: ChildInfo = {
	handle: AGENT_HANDLE,
	name: "main agent",
	state: "idle",
	provider: "faux",
	model: "faux-1",
	thinking: "off",
	cwd: "/tmp",
};

// SAFETY: an ID is a number, and the code under test does not look it up.
const conversationId = 1 as ConversationId;

/** A mirror that an attachment made: what it sent, the failure of its next send, and the change callback. */
type Made = {
	readonly mirror: FakeMirror;
	readonly sent: [string, boolean][];
	failure: Error | undefined;
	/** Takes `status`, with a view and a child, and tells the attachment. */
	readonly change: (status: MirrorStatus) => void;
};

/** The mirrors that the attachments of the tests made, in order. */
const made: Made[] = [];

/** A mirror without a host, with only the members of `Mirror`. A test acts on it through its `Made`. */
class FakeMirror {
	readonly target: MirrorTarget;
	status: MirrorStatus = { kind: "connecting" };
	view: ConversationView | undefined;
	child: ChildInfo | undefined;
	readonly send: (text: string, followUp: boolean) => Promise<void>;

	constructor(target: MirrorTarget, onChange: (previous: MirrorStatus) => void) {
		this.target = target;

		const record: Made = {
			mirror: this,
			sent: [],
			failure: undefined,
			change: (status) => {
				const previous = this.status;
				this.status = status;
				this.view ??= viewOf({});
				this.child ??= CHILD;
				onChange(previous);
			},
		};

		this.send = async (text, followUp) => {
			record.sent.push([text, followUp]);
			const failure = record.failure;
			record.failure = undefined;

			if (failure !== undefined) throw failure;
		};

		made.push(record);
	}

	/** The title as `Mirror` gives it, from the same functions. */
	get title(): string {
		return this.child === undefined ? mirror.targetTitle(this.target) : protocol.childTitle(this.child);
	}

	get busy(): boolean {
		return this.status.kind === "open" && this.child?.state === "busy";
	}

	close(): void {}

	async abort(): Promise<string[]> {
		return [];
	}

	async configure(): Promise<void> {}
}

/** A conversation view with the live document `live` and `entries`. */
function viewOf(live: LiveState, entries: readonly EntryRecord[] = []): ConversationView {
	return { conversation: { id: conversationId }, entries, docs: { "pi.live": live } };
}

/** A conversation view with the list of todos `todos`. */
function withTodos(todos: Todo[]): ConversationView {
	const view = viewOf({});

	return { ...view, docs: { ...view.docs, [TODO_LIST_KIND]: { todos } } };
}

/** An answer as the live document streams it, and as its entry holds it. */
type Answer = NonNullable<NonNullable<LiveState["generation"]>["message"]>;

/** An assistant message with `content`, made at `timestamp`. */
function answer(timestamp: number, content: Answer["content"]): Answer {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** The entry `id` of the answer `message`. */
function answerEntry(id: number, message: Answer): EntryRecord {
	// SAFETY: as for `conversationId`.
	return { id: id as EntryId, conversationId, kind: "pi.assistant", model: [message] };
}

/** The mirror entry with `target`, as Pi keeps it in the session. */
function mirrorEntry(target: MirrorTarget): coding.CustomEntry {
	return {
		type: "custom",
		customType: MIRROR_ENTRY,
		data: toMirrorEntry(target),
		id: "mirror-1",
		parentId: null,
		timestamp: "",
	};
}

/** An event that the tests give to a handler of the mirror. */
type TestEvent = {
	readonly type: string;
	readonly reason?: string;
	readonly text?: string;
	readonly kind?: string;
};

/** A handler of the mirror; the `input` handler gives a result. */
type Handler = (event: TestEvent, ctx: coding.ExtensionContext) => coding.InputEventResult | undefined;

/** The theme of the tests: no colors. */
const PLAIN: Pick<coding.Theme, "fg" | "bold"> = { fg: (_name, text) => text, bold: (text) => text };

// SAFETY: the attachment draws with `fg` and `bold` of the theme only.
const THEME = PLAIN as coding.Theme;

/** The editor factory of the attachment. */
type EditorFactory = Parameters<coding.ExtensionUIContext["setEditorComponent"]>[0];

/** A fake Pi session with the mirror handlers of the extension. */
class Session {
	readonly handlers = new Map<string, Handler>();
	readonly notes: string[] = [];
	readonly terminal = new FakeTerminal();
	readonly ui = new TuiMainScreen(this.terminal);
	readonly ctx: coding.ExtensionContext;
	/** The lines of each call that set a widget with lines, for each widget, in order; undefined hides the widget. */
	readonly widgets = new Map<string, (readonly string[] | undefined)[]>();
	text = "";
	/** The renderer of the mirror entry. */
	renderer: coding.EntryRenderer | undefined;
	#editorFactory: EditorFactory;

	/** A session in `mode` with the entries `branch`, in a Pi with the flags `flags`. */
	constructor(
		mode: coding.ExtensionContext["mode"],
		branch: readonly coding.SessionEntry[],
		flags: Readonly<Record<string, string>> = {},
	) {
		const ctx: Pick<coding.ExtensionContext, "cwd" | "hasUI" | "model" | "mode"> & {
			readonly modelRegistry: Pick<coding.ExtensionContext["modelRegistry"], "find">;
			readonly sessionManager: Pick<coding.ExtensionContext["sessionManager"], "getBranch">;
			readonly ui: Pick<
				coding.ExtensionUIContext,
				"theme" | "setWidget" | "setEditorComponent" | "notify" | "getEditorText" | "setEditorText"
			>;
		} = {
			mode,
			hasUI: mode !== "print",
			cwd: "/tmp",
			model: undefined,
			modelRegistry: { find: () => undefined },
			sessionManager: { getBranch: () => [...branch] },
			ui: {
				theme: THEME,
				setWidget: (key: string, content: string[] | ((ui: TUI, theme: coding.Theme) => Component) | undefined) => {
					if (content instanceof Function) content(this.ui, THEME);
					else this.widgets.set(key, [...(this.widgets.get(key) ?? []), content]);
				},
				setEditorComponent: (factory) => {
					this.#editorFactory = factory;
				},
				notify: (message) => {
					this.notes.push(message);
				},
				getEditorText: () => this.text,
				setEditorText: (text) => {
					this.text = text;
				},
			},
		};

		// SAFETY: the mirror and the attachment read only these fields of the context.
		this.ctx = ctx as coding.ExtensionContext;

		const pi: Pick<
			coding.ExtensionAPI,
			| "registerFlag"
			| "registerEntryRenderer"
			| "registerCommand"
			| "getFlag"
			| "appendEntry"
			| "getSettings"
			| "getSessionName"
			| "setSessionName"
			| "getThinkingLevel"
			| "setThinkingLevel"
			| "setModel"
			| "on"
		> = {
			registerFlag: () => {},
			registerEntryRenderer: (_type, renderer) => {
				// SAFETY: the mirror registers one renderer, for its own entry, and the tests give it only that entry.
				this.renderer = renderer as coding.EntryRenderer;
			},
			registerCommand: () => {},
			// SAFETY: the tests call only the handlers of the mirror, with the events and the context that they read.
			on: ((event: string, handler: Handler) => {
				this.handlers.set(event, handler);
			}) as coding.ExtensionAPI["on"],
			getFlag: (name) => flags[name],
			appendEntry: () => {},
			getSettings: () => ({}),
			getSessionName: () => undefined,
			setSessionName: () => {},
			getThinkingLevel: () => "off",
			setThinkingLevel: () => {},
			setModel: async () => true,
		};

		const harness = {
			mirror: { ...mirror, Mirror: FakeMirror },
			projects,
			protocol,
			viewState,
		};

		// No test reads the list of a session that is not a mirror session.
		const todos = new PolledWidget("todos", async () => undefined, protocol.errorMessage);

		// SAFETY: the mirror calls only these functions of Pi. It uses only these modules of the harness, from `src/` in
		// place of `dist/`, and only the members of `Mirror` that `FakeMirror` has. The fake mirror makes sure that no test
		// starts a host. The classes of `src/` are not those of `dist/` for the type check, so the harness goes as `never`.
		registerMirror(pi as coding.ExtensionAPI, harness as never, todos);
	}

	/** Calls the handler of `event`, with `data`. */
	emit(event: string, data: Omit<TestEvent, "type"> = {}): coding.InputEventResult | undefined {
		const handler = this.handlers.get(event);

		if (handler === undefined) throw new Error(`no handler for ${event}`);

		return handler({ type: event, ...data }, this.ctx);
	}

	/** The editor of the attachment, with Pi's keys for the interrupt and the follow-up. */
	editor(): coding.CustomEditor {
		const keys = new KeybindingsManager({
			...TUI_KEYBINDINGS,
			"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
			"app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
		});

		const theme = { borderColor: (text: string) => text, selectList: coding.getSelectListTheme() };

		// SAFETY: the editor of the mirror uses only `matches` of Pi's keybindings, which pi-tui's manager has.
		const editor = this.#editorFactory?.(this.ui, theme, keys as coding.KeybindingsManager);

		if (!(editor instanceof coding.CustomEditor)) throw new Error("no mirror editor");

		return editor;
	}
}

/** A mirror session at its start in Pi's interactive mode, and its mirror. */
function attached() {
	const session = new Session("tui", [mirrorEntry(AGENT)]);
	session.emit("session_start", { reason: "startup" });
	const mirror = made.at(-1);

	if (mirror === undefined) throw new Error("no mirror");

	return { session, mirror };
}

/** The text of the transcript of `chat`. */
function drawn(chat: ChatView): string {
	return stripVTControlCharacters(chat.transcript.render(100).join("\n"));
}

/** A transcript without a host. */
function chatView(): ChatView {
	return new ChatView(new TuiMainScreen(new FakeTerminal()), "/tmp", (_name, text) => text, viewState);
}

beforeAll(() => {
	coding.initTheme();
});

describe("mirror sessions in Pi", () => {
	it("refuses a mirror session outside Pi's interactive mode, and keeps its input from Pi's agent", () => {
		const entry = new Session("print", [mirrorEntry(AGENT)]);
		const refusal = "harness: a mirror session works only in Pi's interactive mode";
		expect(() => entry.emit("session_start", { reason: "startup" })).toThrow(refusal);
		expect(entry.emit("input", { text: "Not for Pi" })).toEqual({ action: "handled" });

		const flagged = new Session("rpc", [], { harness: "main" });
		expect(() => flagged.emit("session_start", { reason: "reload" })).toThrow(refusal);
		expect(flagged.emit("input", { text: "Not for Pi" })).toEqual({ action: "handled" });

		const plain = new Session("print", []);
		plain.emit("session_start", { reason: "startup" });
		expect(plain.emit("input", { text: "For Pi" })).toBeUndefined();
	});

	it("tells at startup that the --harness flags are not used in a session that is already a mirror session", () => {
		const session = new Session("tui", [mirrorEntry(AGENT)], { harness: "work" });
		const warning = "harness: the --harness flags are not used: the session is already a mirror session";
		session.emit("session_start", { reason: "startup" });
		expect(session.notes).toEqual([warning]);
		session.emit("session_shutdown");
		session.emit("session_start", { reason: "reload" });
		expect(session.notes).toEqual([warning]);
		session.emit("session_shutdown");
	});

	it("keeps a text that the host may have out of the editor, and gives back a text that it does not have", async () => {
		const { session, mirror } = attached();
		session.text = "Draft";
		mirror.failure = new PossiblySentError("The harness host closed the connection");
		session.emit("input", { text: "Maybe sent" });
		await until(() => session.notes.length === 1);
		expect(session.notes).toEqual([
			"harness: maybe sent: The harness host closed the connection. The text is in the history of the editor",
		]);
		expect(session.text).toBe("Draft");

		mirror.failure = new Error("Unknown subagent: abc");
		session.emit("input", { text: "Not sent" });
		await until(() => session.notes.length === 2);
		expect(session.notes[1]).toBe("harness: not sent: Unknown subagent: abc");
		expect(session.text).toBe("Draft\n\nNot sent");
		session.emit("session_shutdown");
	});

	it("queues the follow-up key as a follow-up while the mirror connects again", () => {
		const { session, mirror } = attached();
		mirror.change({ kind: "open" });
		mirror.change({ kind: "reconnecting" });
		const editor = session.editor();
		editor.setText("Mirror follow-up later");
		editor.handleInput("\x1b\r");
		expect(mirror.sent).toEqual([["Mirror follow-up later", true]]);
		expect(editor.getText()).toBe("");
		session.emit("session_shutdown");
	});

	it("reports done to the terminal after a turn of the agent, through a reconnection, and idle after a failure", () => {
		const { session, mirror } = attached();
		const report = (state: string, message = "main agent") => ({ state, app: "harness", message });
		mirror.mirror.child = { ...CHILD, state: "busy" };
		mirror.change({ kind: "open" });
		mirror.change({ kind: "reconnecting" });
		mirror.mirror.child = { ...CHILD, state: "idle" };
		mirror.change({ kind: "open" });
		mirror.change({ kind: "failed", reason: "Unknown subagent: abc" });
		session.emit("session_shutdown");
		expect(session.terminal.statuses).toEqual([
			report("idle"),
			report("working"),
			report("blocked", "main agent (connecting again)"),
			report("done"),
			report("idle"),
			report("idle"),
		]);
	});

	it("shows the marker of an RLM child in the first line, between the title and the directory", () => {
		const header = (child: ChildInfo): string => {
			const { session, mirror } = attached();
			mirror.mirror.child = child;
			mirror.change({ kind: "open" });
			// SAFETY: the renderer of the mirror entry reads only `expanded` of the options.
			const options = { expanded: false } as coding.EntryRenderOptions;
			const frame = session.renderer?.(mirrorEntry(AGENT), options, THEME);
			const first = stripVTControlCharacters(frame?.render(100)[0] ?? "").trim();
			session.emit("session_shutdown");

			return first;
		};

		const child = { ...CHILD, handle: "abc123", name: "sub" };
		expect(header(child)).toBe("harness │ sub (abc123) │ /tmp");
		const { name: _, ...unnamed } = child;
		expect(header({ ...unnamed, kind: "rlm" })).toBe("harness │ abc123 │ rlm │ /tmp");
	});

	it("shows the todos of the agent below the editor while one is open or doing, only on a change, until the session ends", () => {
		const { session, mirror } = attached();
		const plan: Todo = { id: 1, text: "Write the plan", state: "open" };
		mirror.mirror.view = withTodos([plan]);
		mirror.change({ kind: "open" });
		// A change of the mirror with the same lines does not set the widget again, which would move it below the others.
		mirror.change({ kind: "open" });
		mirror.change({ kind: "reconnecting" });
		mirror.mirror.view = withTodos([{ ...plan, state: "done" }]);
		mirror.change({ kind: "open" });
		mirror.change({ kind: "open" });
		mirror.mirror.view = withTodos([
			{ ...plan, state: "done" },
			{ id: 2, text: "Ship it", state: "doing" },
		]);
		mirror.change({ kind: "open" });
		mirror.change({ kind: "open" });
		session.emit("session_shutdown");
		expect(session.widgets.get("todos")).toEqual([
			["○ 1 Write the plan"],
			undefined,
			["✓ 1 Write the plan", "◉ 2 Ship it"],
			undefined,
		]);
	});

	it("reports the state of the agent again when a dialog of Pi ends, until Pi leaves the session", () => {
		const { session, mirror } = attached();
		const states = () => session.terminal.statuses.map(({ state }) => state);
		mirror.mirror.child = { ...CHILD, state: "busy" };
		mirror.change({ kind: "open" });
		mirror.mirror.child = { ...CHILD, state: "idle" };
		mirror.change({ kind: "open" });
		session.emit("ui_prompt_end", { reason: "ui_prompt", kind: "select" });
		expect(states()).toEqual(["idle", "working", "done", "done"]);
		session.emit("session_shutdown");
		session.emit("ui_prompt_end", { reason: "ui_prompt", kind: "confirm" });
		expect(states()).toEqual(["idle", "working", "done", "done", "idle"]);
	});
});

describe("chat view", () => {
	it("takes the streamed answer into its entry, in the same component", () => {
		const chat = chatView();
		const streamed = answer(5, [{ type: "text", text: "Streamed answer" }]);
		chat.apply(viewOf({ generation: { attempt: 1, message: streamed } }));
		const component = chat.transcript.children.at(-1);
		chat.apply(viewOf({}, [answerEntry(1, streamed)]));
		expect(chat.transcript.children).toEqual([component]);
		expect(drawn(chat)).toContain("Streamed answer");
	});

	it("draws a new answer that is not the streamed one without the cards of the streamed one", () => {
		const chat = chatView();
		const call = { type: "toolCall" as const, id: "stale-call", name: "bash", arguments: { command: "echo stale" } };
		chat.apply(viewOf({ generation: { attempt: 1, message: answer(5, [call]) } }));
		expect(drawn(chat)).toContain("echo stale");
		chat.apply(viewOf({}, [answerEntry(1, answer(6, [{ type: "text", text: "Other answer" }]))]));
		expect(drawn(chat)).toContain("Other answer");
		expect(drawn(chat)).not.toContain("echo stale");
	});

	it("keeps the drawn entries when the window of the view drops its oldest ones", () => {
		const chat = chatView();
		const first = answerEntry(1, answer(1, [{ type: "text", text: "First answer" }]));
		const second = answerEntry(2, answer(2, [{ type: "text", text: "Second answer" }]));
		chat.apply(viewOf({}, [first, second]));
		const components = [...chat.transcript.children];
		chat.apply({
			...viewOf({}, [second, answerEntry(3, answer(3, [{ type: "text", text: "Third answer" }]))]),
			before: first.id,
		});
		expect(chat.transcript.children).toHaveLength(components.length + 1);

		for (const [index, component] of components.entries()) expect(chat.transcript.children[index]).toBe(component);
		expect(drawn(chat)).toContain("First answer");
		expect(drawn(chat)).toContain("Third answer");
	});

	it("keeps the entries before the window when a streamed answer is dropped", () => {
		const chat = chatView();
		const first = answerEntry(1, answer(1, [{ type: "text", text: "First answer" }]));
		const second = answerEntry(2, answer(2, [{ type: "text", text: "Second answer" }]));
		chat.apply(viewOf({}, [first, second]));
		chat.apply({ ...viewOf({}, [second]), before: first.id });
		const partial = answer(9, [{ type: "text", text: "Partial answer" }]);
		chat.apply({ ...viewOf({ generation: { attempt: 1, message: partial } }, [second]), before: first.id });
		chat.apply({ ...viewOf({}, [second]), before: first.id });
		expect(drawn(chat)).toContain("First answer");
		expect(drawn(chat)).toContain("Second answer");
		expect(drawn(chat)).not.toContain("Partial answer");
	});

	it("keeps the entries before the window when a new answer is not the streamed one", () => {
		const chat = chatView();
		const first = answerEntry(1, answer(1, [{ type: "text", text: "First answer" }]));
		const second = answerEntry(2, answer(2, [{ type: "text", text: "Second answer" }]));
		chat.apply(viewOf({}, [first, second]));
		chat.apply({ ...viewOf({}, [second]), before: first.id });
		const call = { type: "toolCall" as const, id: "stale-call", name: "bash", arguments: { command: "echo stale" } };
		chat.apply({ ...viewOf({ generation: { attempt: 1, message: answer(5, [call]) } }, [second]), before: first.id });
		const third = answerEntry(3, answer(6, [{ type: "text", text: "Third answer" }]));
		chat.apply({ ...viewOf({}, [second, third]), before: first.id });
		expect(drawn(chat)).toContain("First answer");
		expect(drawn(chat)).toContain("Third answer");
		expect(drawn(chat)).not.toContain("echo stale");
	});

	it("shows a running card as interrupted when no connection gives its result", () => {
		const chat = chatView();
		// SAFETY: as for `conversationId`.
		const taskId = 1 as TaskId;
		chat.apply(viewOf({ tools: [{ status: "running", name: "bash", callId: "c1", taskId }] }));
		chat.stopTimers();
		expect(drawn(chat)).toContain("Interrupted: no connection to the harness host");
	});
});
