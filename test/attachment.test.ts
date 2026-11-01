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
import { beforeAll, describe, expect, it } from "vitest";
import { ChatView } from "../pi/chat.ts";
import { registerMirror } from "../pi/mirror.ts";
import type { AgentReporter } from "../src/herdr.ts";
import * as herdr from "../src/herdr.ts";
import * as mirror from "../src/mirror.ts";
import { MIRROR_ENTRY, type MirrorStatus, type MirrorTarget, PossiblySentError } from "../src/mirror.ts";
import * as projects from "../src/projects.ts";
import * as protocol from "../src/protocol.ts";
import { AGENT_HANDLE, type ChildInfo } from "../src/protocol.ts";
import * as viewState from "../src/view-state.ts";
import { FakeTerminal, until } from "./helpers.ts";

const AGENT: MirrorTarget = { project: "main", handle: AGENT_HANDLE };

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

	get busy(): boolean {
		return this.status.kind === "open" && this.child?.state === "busy";
	}

	close(): void {}

	async abort(): Promise<string[]> {
		return [];
	}

	async configure(): Promise<void> {}
}

/** A Herdr reporter that counts its calls. A release ends when `released` resolves. */
class FakeReporter implements AgentReporter {
	reports = 0;
	releases = 0;
	released: Promise<void> = Promise.resolve();

	async report(): Promise<void> {
		this.reports++;
	}

	async release(): Promise<void> {
		this.releases++;
		await this.released;
	}
}

/** A conversation view with the live document `live` and `entries`. */
function viewOf(live: LiveState, entries: readonly EntryRecord[] = []): ConversationView {
	return { conversation: { id: conversationId }, entries, docs: { "pi.live": live } };
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
function mirrorEntry(target: MirrorTarget): coding.SessionEntry {
	return { type: "custom", customType: MIRROR_ENTRY, data: target, id: "mirror-1", parentId: null, timestamp: "" };
}

/** An event that the tests give to a handler of the mirror. */
type TestEvent = { readonly type: string; readonly reason?: string; readonly text?: string };

/** A handler of the mirror; the `input` handler gives a result, and the `session_shutdown` handler a promise. */
type Handler = (event: TestEvent, ctx: coding.ExtensionContext) => coding.InputEventResult | Promise<void> | undefined;

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
	readonly reporter = new FakeReporter();
	readonly ui = new TuiMainScreen(new FakeTerminal());
	readonly ctx: coding.ExtensionContext;
	text = "";
	#editorFactory: EditorFactory;

	/** A session in `mode` with the entries `branch`, in a Pi with the flags `flags`. */
	constructor(
		mode: coding.ExtensionContext["mode"],
		branch: readonly coding.SessionEntry[],
		flags: Readonly<Record<string, string>> = {},
	) {
		const ctx: Pick<coding.ExtensionContext, "cwd" | "model" | "mode"> & {
			readonly modelRegistry: Pick<coding.ExtensionContext["modelRegistry"], "find">;
			readonly sessionManager: Pick<coding.ExtensionContext["sessionManager"], "getBranch">;
			readonly ui: Pick<
				coding.ExtensionUIContext,
				"theme" | "setWidget" | "setEditorComponent" | "notify" | "getEditorText" | "setEditorText"
			>;
		} = {
			mode,
			cwd: "/tmp",
			model: undefined,
			modelRegistry: { find: () => undefined },
			sessionManager: { getBranch: () => [...branch] },
			ui: {
				theme: THEME,
				setWidget: (_key: string, content: string[] | ((ui: TUI, theme: coding.Theme) => Component) | undefined) => {
					if (content instanceof Function) content(this.ui, THEME);
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
		const reporter = this.reporter;

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
			registerEntryRenderer: () => {},
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
			herdr: { ...herdr, agentReporter: () => reporter },
			projects,
			protocol,
			viewState,
		};

		// SAFETY: the mirror calls only these functions of Pi. It uses only these modules of the harness, from `src/` in
		// place of `dist/`, and only the members of `Mirror` that `FakeMirror` has. The fake mirror and the fake Herdr
		// reporter make sure that no test starts a host or Herdr. The classes of `src/` are not those of `dist/` for the
		// type check, so the harness goes as `never`.
		registerMirror(pi as coding.ExtensionAPI, harness as never);
	}

	/** Calls the handler of `event`, with `data`. */
	emit(event: string, data: Omit<TestEvent, "type"> = {}): coding.InputEventResult | Promise<void> | undefined {
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

	it("releases the agent in Herdr when the mirror fails, and reports no more", () => {
		const { session, mirror } = attached();
		mirror.change({ kind: "open" });
		expect(session.reporter.reports).toBe(1);
		mirror.change({ kind: "failed", reason: "Unknown subagent: abc" });
		mirror.change({ kind: "failed", reason: "Unknown subagent: abc" });
		expect(session.reporter).toMatchObject({ reports: 1, releases: 1 });
		session.emit("session_shutdown");
		expect(session.reporter.releases).toBe(1);
	});

	it("ends the session shutdown only after Herdr has released the agent", async () => {
		const { session, mirror } = attached();
		mirror.change({ kind: "open" });
		const release = Promise.withResolvers<void>();
		session.reporter.released = release.promise;
		let ended = false;

		const shutdown = Promise.resolve(session.emit("session_shutdown")).then(() => {
			ended = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.reporter.releases).toBe(1);
		expect(ended).toBe(false);
		release.resolve();
		await shutdown;
		expect(ended).toBe(true);
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

	it("shows a running card as interrupted when no connection gives its result", () => {
		const chat = chatView();
		// SAFETY: as for `conversationId`.
		const taskId = 1 as TaskId;
		chat.apply(viewOf({ tools: [{ status: "running", name: "bash", callId: "c1", taskId }] }));
		chat.stopTimers();
		expect(drawn(chat)).toContain("Interrupted: no connection to the harness host");
	});
});
