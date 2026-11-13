import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	KeybindingsManager,
	Markdown,
	type MarkdownTheme,
	type TUI,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { System } from "../pi/clipboard.ts";
import type { CopyResult } from "../pi/copy-choice.ts";
import { registerVisualCopy } from "../pi/visual-copy.ts";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import * as protocol from "../src/protocol/index.ts";
import type { Request } from "../src/protocol/requests.ts";
import * as tool from "../src/tool.ts";
import { root, setUp, startHost, tearDown } from "./helpers.ts";

const style = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[39m`;

const MARKDOWN_THEME: MarkdownTheme = {
	heading: style(33),
	link: style(34),
	linkUrl: style(90),
	code: style(36),
	codeBlock: style(32),
	codeBlockBorder: style(90),
	quote: style(37),
	quoteBorder: style(90),
	hr: style(90),
	listBullet: style(36),
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

/** The theme of the view: no colors. */
const PLAIN: Pick<Theme, "fg" | "bg" | "bold" | "inverse" | "getFgAnsi"> = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => text,
	getFgAnsi: () => "\x1b[38;5;1m",
};

// SAFETY: the view draws with these members of the theme only.
const THEME = PLAIN as Theme;

/** An assistant message of Pi, with the members that /vc reads: its content container and `updateContent`. */
class Assistant extends Container {
	readonly contentContainer = new Container();

	constructor(text: string) {
		super();
		this.contentContainer.addChild(new Markdown(text, 1, 0, MARKDOWN_THEME));
		this.addChild(this.contentContainer);
	}

	updateContent(): void {}
}

/** An image of a tool result, which draws one row. */
class Picture implements Component {
	readonly base64Data = Buffer.from("image").toString("base64");
	readonly mimeType = "image/png";

	render(): string[] {
		return ["[picture]"];
	}

	invalidate(): void {}
}

/** A tool result of Pi with one image, with the members that /vc reads. */
class ImageTool extends Container {
	readonly toolName = "screenshot";
	readonly imageComponents = [new Picture()];

	constructor() {
		super();

		for (const image of this.imageComponents) this.addChild(image);
	}
}

/** A run of a program that the extension asked for. */
type Ran = { readonly command: string; readonly args: readonly string[]; readonly input: string | undefined };

/** A system for the tests: it records the copied texts and the runs, and starts no program. */
function testSystem(platform: NodeJS.Platform, release: string, env: NodeJS.ProcessEnv = {}) {
	const copied: string[] = [];
	const ran: Ran[] = [];

	const system: System = {
		platform,
		release,
		env,
		copyText: async (text) => {
			copied.push(text);
		},
		run: async (command, args, input) => {
			ran.push({ command, args, input });

			return command === "wslpath" ? "C:\\Temp\\picture.png\n" : "";
		},
	};

	return { system, copied, ran };
}

/** A notification that the extension showed. */
type Note = { readonly message: string; readonly type: string | undefined };

type Done = (result: CopyResult | undefined) => void;

type Factory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: Done) => Component;

let host: Host | undefined;

/** The requests that the extension sent to the host, in order. */
const sent: Request[] = [];

/** The error of each request to the host, when the host is unreachable for a test. */
let failure: Error | undefined;

/** With `threadOnly`, a thread read gives the thread without its messages, as a broken host would. */
let threadOnly = false;

const sendToHost: tool.Send = async (message, signal) => {
	sent.push(message);

	if (failure !== undefined) throw failure;
	const reply = await tool.sendToHost(message, signal);

	if (threadOnly) Reflect.deleteProperty(reply, "messages");

	return reply;
};

beforeEach(async () => {
	await setUp();
	host = await startHost();
	sent.length = 0;
	failure = undefined;
	threadOnly = false;
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	await tearDown();
});

/**
 * Runs `/vc` on `system` over a transcript with `owners`, and gives it `keys`. It gives the notifications of the
 * extension.
 */
async function visualCopy(system: System, owners: readonly Component[], keys: readonly string[]): Promise<Note[]> {
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const document = new Container();

	for (const owner of owners) document.addChild(owner);

	const pi: Pick<ExtensionAPI, "registerCommand" | "registerShortcut"> = {
		registerCommand: (name, options) => {
			if (name === "vc") command = options;
		},
		registerShortcut: () => {},
	};

	const tuiParts: Pick<TUI, "children" | "terminal" | "requestRender"> = {
		children: [document],
		// SAFETY: /vc reads only the columns of the terminal.
		terminal: { columns: 60 } as TUI["terminal"],
		requestRender: () => {},
	};

	// SAFETY: /vc reads only these members of the TUI, and it finds no scroll view.
	const tui = tuiParts as TUI;
	const notes: Note[] = [];

	const ctx = {
		mode: "tui",
		signal: undefined,
		sessionManager: { getSessionId: () => "session" },
		ui: {
			notify: (message: string, type?: string) => {
				notes.push({ message, type });
			},
			custom: (factory: Factory) =>
				new Promise<CopyResult | undefined>((done) => {
					const view = factory(tui, THEME, new KeybindingsManager(TUI_KEYBINDINGS), done);

					for (const key of keys) view.handleInput?.(key);
				}),
		},
	};

	// SAFETY: /vc uses only these functions of Pi and these modules of the harness, from `src/` in place of `dist/`. The
	// classes of `src/` are not those of `dist/` for the type check, so the harness goes as `never`.
	registerVisualCopy(pi as ExtensionAPI, { protocol, tool: { ...tool, sendToHost } } as never, system);

	if (command === undefined) throw new Error("no /vc command");
	// SAFETY: /vc reads only these fields of the context.
	await command.handler("", ctx as never);

	return notes;
}

/** The marks that the extension sent. */
function marks(): Request[] {
	return sent.filter((message) => message.type === "message" && message.action === "mark");
}

/** Adds a thread with Sam and a draft to Sam with `text`, and gives the thread ID and the draft ID. */
async function addDraft(text: string): Promise<{ thread: number; draft: number }> {
	await request({ type: "person", action: "add", name: "Sam" }, { start: false });
	const thread = await request({ type: "thread", action: "add", topic: "Build", persons: [1] }, { start: false });

	if (thread === undefined || !("id" in thread)) throw new Error("no thread");

	const draft = await request(
		{ type: "message", action: "log", caller: "cli", thread: thread.id, from: "user", direction: "out", text },
		{ start: false },
	);

	if (draft === undefined) throw new Error("no draft");

	return { thread: thread.id, draft: draft.id };
}

/** The states of the messages of the thread. */
async function states(thread: number): Promise<string[]> {
	const reply = await request({ type: "thread", action: "read", id: thread }, { start: false });

	return reply !== undefined && "messages" in reply ? reply.messages.map((message) => message.state) : [];
}

const PLATFORMS: readonly [string, NodeJS.Platform, string][] = [
	["macOS", "darwin", "24.0.0"],
	["Linux", "linux", "6.8.0-generic"],
	["WSL", "linux", "5.15.153.1-microsoft-standard-WSL2"],
];

describe("/vc", () => {
	it.each(PLATFORMS)("copies the code of a code block without its fences on %s", async (_name, platform, release) => {
		const { system, copied } = testSystem(platform, release);
		const notes = await visualCopy(system, [new Assistant("Run this:\n\n```sh\nnpm test\n```")], ["y"]);

		expect(copied).toEqual(["npm test"]);
		expect(notes).toEqual([{ message: "Copied 1 line: npm test", type: "info" }]);
	});

	it("copies an image with osascript on macOS", async () => {
		const { system, ran, copied } = testSystem("darwin", "24.0.0");
		const notes = await visualCopy(system, [new ImageTool()], ["y"]);
		const file = expect.stringMatching(/pi-vc-[0-9a-f]{16}\.png$/);

		expect(ran).toEqual([
			{
				command: "osascript",
				args: ["-l", "JavaScript", "-e", expect.stringContaining("NSPasteboard"), file, "image/png"],
				input: undefined,
			},
		]);
		expect(copied).toEqual([]);
		expect(notes).toEqual([{ message: "Copied image", type: "info" }]);
		expect(sent).toEqual([]);
	});

	it("copies an image with wl-copy on Wayland", async () => {
		const bin = await mkdtemp(join(root, "bin-"));
		await writeFile(join(bin, "wl-copy"), "");
		const { system, ran } = testSystem("linux", "6.8.0-generic", { WAYLAND_DISPLAY: "wayland-0", PATH: bin });

		await visualCopy(system, [new ImageTool()], ["y"]);

		expect(ran).toEqual([
			{ command: "wl-copy", args: ["--type", "image/png"], input: expect.stringMatching(/pi-vc-[0-9a-f]{16}\.png$/) },
		]);
	});

	it("copies an image with PowerShell on WSL, from the Windows path of the file", async () => {
		const { system, ran } = testSystem("linux", "5.15.153.1-microsoft-standard-WSL2");

		await visualCopy(system, [new ImageTool()], ["y"]);
		const script = Buffer.from(String(ran[1]?.args.at(-1)), "base64").toString("utf16le");

		expect(ran).toEqual([
			{ command: "wslpath", args: ["-w", expect.stringMatching(/pi-vc-[0-9a-f]{16}\.png$/)], input: undefined },
			{
				command: "powershell.exe",
				args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", expect.any(String)],
				input: undefined,
			},
		]);
		expect(script).toMatch(/^\$InputFile = 'C:\\Temp\\picture\.png'\n/);
	});

	it("marks sent a draft that a text copy holds", async () => {
		const { thread, draft } = await addDraft("Hi Sam, the build is green.");
		const { system, copied } = testSystem("darwin", "24.0.0");

		const notes = await visualCopy(
			system,
			[new Assistant("Here is the reply:\n\nHi Sam,\nthe build is green.")],
			["y"],
		);

		expect(copied).toEqual(["Hi Sam,\nthe build is green."]);
		expect(marks()).toEqual([{ type: "message", action: "mark", caller: "session", message: draft, state: "sent" }]);
		expect(notes).toEqual([
			{ message: "Copied 2 lines: Hi Sam,", type: "info" },
			{ message: `Draft ${draft} marked sent`, type: "info" },
		]);
		expect(await states(thread)).toEqual(["sent"]);
	});

	it("marks no draft for a copy of another text", async () => {
		const { thread } = await addDraft("Hi Sam, the build is green.");
		const { system } = testSystem("darwin", "24.0.0");
		const notes = await visualCopy(system, [new Assistant("Hi Sam, the build is red.")], ["y"]);

		expect(sent.map((message) => message.type)).toEqual(["thread", "thread"]);
		expect(marks()).toEqual([]);
		expect(notes).toEqual([{ message: "Copied 1 line: Hi Sam, the build is red.", type: "info" }]);
		expect(await states(thread)).toEqual(["draft"]);
	});

	it("warns when it cannot read the drafts, and keeps the copy", async () => {
		failure = new Error("host down");
		const { system, copied } = testSystem("darwin", "24.0.0");
		const notes = await visualCopy(system, [new Assistant("Hello")], ["y"]);

		expect(copied).toEqual(["Hello"]);
		expect(notes).toEqual([
			{ message: "Copied 1 line: Hello", type: "info" },
			{ message: "Could not read the drafts: host down", type: "warning" },
		]);
	});

	it("warns when a thread read gives no messages, and marks no draft", async () => {
		const { thread } = await addDraft("Hello");
		threadOnly = true;
		const { system, copied } = testSystem("darwin", "24.0.0");
		const notes = await visualCopy(system, [new Assistant("Hello")], ["y"]);

		expect(copied).toEqual(["Hello"]);
		expect(marks()).toEqual([]);
		expect(notes).toEqual([
			{ message: "Copied 1 line: Hello", type: "info" },
			{ message: "Could not read the drafts: The host replied with no messages", type: "warning" },
		]);
		expect(await states(thread)).toEqual(["draft"]);
	});
});
