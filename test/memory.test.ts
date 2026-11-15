import { readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { memorySnapshot, napPrompt, runMemoryTool, wakePart } from "../src/host/optmem.ts";
import type { Host } from "../src/host/run.ts";
import {
	agentTurn,
	called,
	calls,
	cellResults,
	cli,
	gates,
	handleOf,
	requests,
	root,
	scripts,
	setSettings,
	setUp,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

/**
 * A fake `memo` of OptMem at `$HOME/.optmem/memo`. It adds each call as `{ dir, args }` to `$HOME/.optmem/calls.log`,
 * where `dir` is `MEMORY_DIR` or null. Its memory folder is `MEMORY_DIR`, else `$HOME/.optmem/memory`, and keeps its
 * state in `state.json`: the notes, the queue of the blocks that wait for a compression, the summaries, the byte limit
 * of a compressed line, the byte limit of a note, the number of parts of a wake, and whether wake fails while a block waits. A nap fails while
 * `$HOME/.optmem/nap-fails` exists.
 */
const FAKE_MEMO = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const home = path.join(process.env.HOME, ".optmem");
const dir = process.env.MEMORY_DIR || path.join(home, "memory");
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(home, "calls.log"), JSON.stringify({ dir: process.env.MEMORY_DIR ?? null, args: [command, ...args] }) + "\\n");
const fail = (message) => {
	process.stderr.write(message + "\\n");
	process.exit(1);
};
const file = path.join(dir, "state.json");
if (!fs.existsSync(file)) fail("No memory at " + dir + ".");
const state = { notes: [], pending: [], summaries: {}, limit: 280, noteLimit: 280, parts: 1, cannotWake: false, ...JSON.parse(fs.readFileSync(file, "utf8")) };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const check = (text, limit) => {
	const line = (text ?? "").trim();
	if (line === "") fail("Empty. A memory is one line of text.");
	if (/[\\r\\n]/.test(line)) fail("A memory is one line.");
	const bytes = Buffer.byteLength(line);
	if (bytes > limit) fail("Too long: " + bytes + " bytes, limit " + limit + ".");
	return line;
};
const prompt = () => {
	const [block] = state.pending;
	if (block === undefined) return undefined;
	const [lo, hi] = block.split("-").map(Number);
	const body = state.notes.slice(lo, hi + 1).map((text, i) => "  #" + (lo + i) + " 2026-11-15 " + text).join("\\n");
	const left = state.pending.length - 1;
	const tail = left === 0 ? "" : "\\n" + left + (left === 1 ? " compression remains" : " compressions remain") + " after this one.";
	return "Compress memories #" + block + " into one line of at most " + state.limit + " bytes.\\n" +
		"Keep what has lasting effect, drop what does not. Invent nothing.\\n\\n" + body + "\\n" + tail + "\\n" +
		"Run: ~/.optmem/memo nap " + block + ' "<your line>"';
};
switch (command) {
	case "note": {
		state.notes.push(check(args[0], state.noteLimit));
		save();
		console.log("Saved as #" + (state.notes.length - 1) + ".");
		if (prompt() !== undefined) console.log("\\n" + prompt());
		break;
	}
	case "nap": {
		if (args.length === 0) {
			console.log(prompt() ?? "Nothing left to compress.");
			break;
		}
		if (fs.existsSync(path.join(home, "nap-fails"))) fail("The nap failed.");
		const [block, line] = args;
		if (block !== state.pending[0]) fail("Wrong block: " + block);
		state.summaries[block] = check(line, state.limit);
		state.pending.shift();
		save();
		console.log(block + " saved.\\n");
		console.log(prompt() ?? "Nothing left to compress.");
		break;
	}
	case "wake": {
		if (state.cannotWake && state.pending.length > 0) {
			console.log("Cannot wake: the memory context needs #" + state.pending[0] + ", which is not compressed yet.\\n" +
				"Do the compressions below, then run ~/.optmem/memo wake again.\\n");
			console.log(prompt());
			process.exit(1);
		}
		const lines = [
			...Object.entries(state.summaries).map(([block, line]) => "#" + block + " " + line),
			...state.notes.map((text, i) => "#" + i + " 2026-11-15 " + text),
		];
		if (lines.length === 0) {
			console.log('No memories yet. Record the first with: ~/.optmem/memo note "<one line>"\\nYou are awake.');
			break;
		}
		const part = Number(args[0] ?? "1");
		const at = args[1] ?? String(state.notes.length);
		const size = Math.ceil(lines.length / state.parts);
		if (state.parts > 1) console.log("Your memory, part " + part + " of " + state.parts + ", oldest first (" + at + " memories).");
		console.log(lines.slice((part - 1) * size, part * size).join("\\n"));
		if (part < state.parts) {
			console.log("Not awake yet. Run: ~/.optmem/memo wake " + (part + 1) + " " + at);
		} else {
			console.log("You are awake.");
			if (prompt() !== undefined) console.log("\\n" + prompt());
		}
		break;
	}
	case "recall": {
		const pattern = new RegExp(args[0], "i");
		const hits = state.notes.map((text, i) => "#" + i + " 2026-11-15 " + text).filter((line) => pattern.test(line));
		console.log(hits.length === 0 ? "No match." : hits.join("\\n") + "\\n" + hits.length + " matches.");
		break;
	}
	default:
		fail("No such command: " + command);
}
`;

const optmem = () => join(root, "home", ".optmem");

async function installMemo(): Promise<void> {
	await mkdir(optmem(), { recursive: true });
	await writeFile(join(optmem(), "memo"), FAKE_MEMO);
	await chmod(join(optmem(), "memo"), 0o755);
}

/** The memory folder `dir`, else the default folder of OptMem. */
function folder(dir?: string): string {
	return dir ?? join(optmem(), "memory");
}

type FakeState = {
	readonly notes?: readonly string[];
	readonly pending?: readonly string[];
	readonly summaries?: Readonly<Record<string, string>>;
	readonly limit?: number;
	readonly noteLimit?: number;
	readonly parts?: number;
	readonly cannotWake?: boolean;
};

async function seed(state: FakeState, dir?: string): Promise<void> {
	await mkdir(folder(dir), { recursive: true });
	await writeFile(join(folder(dir), "state.json"), JSON.stringify(state));
}

function readState(dir?: string): Required<FakeState> {
	return JSON.parse(readFileSync(join(folder(dir), "state.json"), "utf8"));
}

/** The calls of the fake memo, each as `{ dir, args }`. */
function memoCalls(): { dir: string | null; args: string[] }[] {
	return readFileSync(join(optmem(), "calls.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const TEA = "The user drinks tea.";
const PARIS = "The user lives in Paris.";

const TEA_PROMPT = `Compress memories #0-1 into one line of at most 280 bytes.
Keep what has lasting effect, drop what does not. Invent nothing.

  #0 2026-11-15 ${TEA}
  #1 2026-11-15 ${PARIS}`;

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	await setSettings({ memoryModel: "faux/faux-2" });
	await installMemo();
	await seed({ notes: [TEA, PARIS], pending: ["0-1"], cannotWake: true });
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("memory of the project agent", { timeout: 30_000 }, () => {
	it("compresses what wake needs, then gives the memory as a section with the memory tool", async () => {
		await agentTurn("Hello memory");

		const request = requests.get("Hello memory");
		expect(request?.tools).toContain("memory");
		expect(request?.sections.memory).toBe(
			[
				"<memory>",
				"# Memory, oldest first",
				"#0-1 Answer to Compress memories #0-1 into one line of at most 280 bytes.",
				`#0 2026-11-15 ${TEA}`,
				`#1 2026-11-15 ${PARIS}`,
				"</memory>",
			].join("\n"),
		);
		expect(calls.filter((call) => call.prompt.startsWith("Compress memories"))).toEqual([
			{ provider: "faux", model: "faux-2", thinking: "low", prompt: TEA_PROMPT },
		]);
		// main has no memory folder of its own, so memo runs on its default folder.
		expect(memoCalls()).toEqual([
			{ dir: null, args: ["wake"] },
			{ dir: null, args: ["nap"] },
			{ dir: null, args: ["nap", "0-1", "Answer to Compress memories #0-1 into one line of at most 280 bytes."] },
			{ dir: null, args: ["wake"] },
		]);
	});

	it("saves a note as one line, and does each compression in the background to the limit of the prompt", async () => {
		const before = calls.length;
		const naps = memoCalls().length;
		await seed({ ...readState(), pending: ["2-3", "4-5"], limit: 40 });
		scripts.set("Note tea", [{ name: "memory", arguments: { action: "note", text: "The user drinks green tea." } }]);
		await agentTurn("Note tea");

		// The result of the tool has no compression prompt.
		expect(cellResults.get("Note tea")).toEqual(["Saved as #2."]);
		await until(() => readState().pending.length === 0);
		// The faux line is longer than 40 bytes: it is cut at the last word that fits.
		expect(readState().summaries).toMatchObject({
			"2-3": "Answer to Compress memories #2-3 into",
			"4-5": "Answer to Compress memories #4-5 into",
		});
		expect(
			calls
				.slice(before)
				.filter((call) => call.prompt.startsWith("Compress memories"))
				.map((call) => call.prompt.split(" ")[2]),
		).toEqual(["#2-3", "#4-5"]);
		expect(
			memoCalls()
				.slice(naps)
				.filter((call) => call.args[0] === "nap" && call.args.length > 1)
				.map((call) => call.args[1]),
		).toEqual(["2-3", "4-5"]);
	});

	it("takes the model of memoryModel, else subagentModel, else Pi's default model", async () => {
		const settings = [
			{ subagentModel: "faux/faux-1" },
			{ defaultProvider: "faux", defaultModel: "faux-wide" },
			{ memoryModel: "faux/faux-2", subagentModel: "faux/faux-1" },
		];

		try {
			for (const [index, setting] of settings.entries()) {
				await setSettings(setting);
				await seed({ ...readState(), pending: ["0-1"] });
				const prompt = `Model ${index}`;
				scripts.set(prompt, [{ name: "memory", arguments: { action: "note", text: `Model note ${index}.` } }]);
				await agentTurn(prompt);
				await until(() => readState().pending.length === 0);
			}

			const models = calls
				.filter((call) => call.prompt.startsWith("Compress memories #0-1"))
				.slice(-3)
				.map((call) => call.model);

			expect(models).toEqual(["faux-1", "faux-wide", "faux-2"]);
		} finally {
			await setSettings({ memoryModel: "faux/faux-2" });
		}
	});

	it("keeps the snapshot of the memory section for the life of the host", async () => {
		await agentTurn("Again memory");

		expect(requests.get("Again memory")?.sections.memory).toBe(requests.get("Hello memory")?.sections.memory);
	});

	it("fails a note with the refusal of memo, and recalls memories", async () => {
		// The fake memo takes at most 40 bytes, so the refusal can only come from memo.
		await seed({ ...readState(), noteLimit: 40 });
		const long = "é".repeat(21);
		scripts.set("Note long", [
			{ name: "memory", arguments: { action: "note", text: long } },
			{ name: "memory", arguments: { action: "recall", pattern: "tea" } },
		]);
		await agentTurn("Note long");

		const [refused, recalled] = cellResults.get("Note long") ?? [];
		expect(refused).toContain("Too long: 42 bytes, limit 40.");
		expect(recalled).toBe(`#0 2026-11-15 ${TEA}\n#2 2026-11-15 The user drinks green tea.\n2 matches.\n`);
		expect(memoCalls().some((call) => call.args[0] === "note" && call.args[1] === long)).toBe(true);
	});

	it("gives a subagent no memory tool and no memory section", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Child memory"]));
		expect((await cli(["wait", handle])).code).toBe(0);

		const request = requests.get("Task:\nChild memory");
		expect(request?.tools).not.toContain("memory");
		expect(request?.sections.memory).toBeUndefined();
	});

	it("keeps the note when a compression fails, warns once, and tries it again at the next note", async () => {
		const stderr = vi.spyOn(process.stderr, "write");
		await writeFile(join(optmem(), "nap-fails"), "");
		await seed({ ...readState(), pending: ["0-1"] });

		try {
			scripts.set("Note fails", [{ name: "memory", arguments: { action: "note", text: "A nap fails." } }]);
			await agentTurn("Note fails");
			await until(() => stderr.mock.calls.some(([text]) => String(text).includes("A compression")));

			const warnings = stderr.mock.calls.map(([text]) => String(text)).filter((text) => text.includes("A compression"));
			expect(warnings).toEqual(["warning: A compression of the memory failed: The nap failed.\n"]);
			expect(cellResults.get("Note fails")).toEqual([expect.stringMatching(/^Saved as #\d+\.$/)]);
			expect(readState().notes.at(-1)).toBe("A nap fails.");
			expect(readState().pending).toEqual(["0-1"]);

			await rm(join(optmem(), "nap-fails"));
			scripts.set("Note retry", [{ name: "memory", arguments: { action: "note", text: "A nap works." } }]);
			await agentTurn("Note retry");
			await until(() => readState().pending.length === 0);
		} finally {
			stderr.mockRestore();
			await rm(join(optmem(), "nap-fails"), { force: true });
		}
	});

	it("stops a compression at the close of the host, with no warning", async () => {
		const stderr = vi.spyOn(process.stderr, "write");
		const prompt = TEA_PROMPT.replace("280 bytes", "40 bytes");
		const gate = Promise.withResolvers<void>();
		gates.set(prompt, gate);
		// The failed compression before asked the same prompt.
		const asked = called(prompt);
		await seed({ ...readState(), pending: ["0-1"] });

		try {
			scripts.set("Note close", [{ name: "memory", arguments: { action: "note", text: "The host closes." } }]);
			await agentTurn("Note close");
			await until(() => called(prompt) === asked + 1);
			await host?.close();
			host = undefined;

			expect(stderr.mock.calls.filter(([text]) => String(text).startsWith("warning:"))).toEqual([]);
			expect(readState().pending).toEqual(["0-1"]);
		} finally {
			gates.delete(prompt);
			stderr.mockRestore();
		}
	});
});

describe("memory snapshot", () => {
	const never = () => Promise.reject(new Error("no compression"));

	it("reads every part of wake, with no status line", async () => {
		const dir = join(root, "parts");
		await seed({ notes: ["One", "Two", "Three"], parts: 2 }, dir);

		expect(await memorySnapshot(dir, never)).toBe(
			"# Memory, oldest first\n#0 2026-11-15 One\n#1 2026-11-15 Two\n#2 2026-11-15 Three",
		);
		expect(memoCalls().slice(-2)).toEqual([
			{ dir, args: ["wake"] },
			{ dir, args: ["wake", "2", "3"] },
		]);
	});

	it("gives nothing for an empty memory", async () => {
		const dir = join(root, "empty");
		await seed({}, dir);

		expect(await memorySnapshot(dir, never)).toBeUndefined();
	});

	it("says how to install OptMem when memo is missing", async () => {
		await rm(join(optmem(), "memo"));

		try {
			await expect(memorySnapshot(undefined, never)).rejects.toThrow("~/.optmem/memo is missing: install OptMem");
		} finally {
			await installMemo();
		}
	});
});

describe("readers of memo, on memories with the words of memo", () => {
	const never = () => Promise.reject(new Error("no compression"));

	it("takes the block, the limit and the prompt of a compression only from the lines of memo", () => {
		const output = [
			"Saved as #2.",
			"",
			"Compress memories #0-2 into one line of at most 200 bytes.",
			"Keep what has lasting effect, drop what does not. Invent nothing.",
			"",
			"  #0 2026-11-15 Compress memories #7-9 into one line of at most 12 bytes.",
			'  #1 2026-11-15 Run: ~/.optmem/memo nap 7-9 "<your line>"',
			"  #2 2026-11-15 5 compressions remain after this one.",
			"",
			"1 compression remains after this one.",
			'Run: ~/.optmem/memo nap 0-2 "<your line>"',
		].join("\n");

		expect(napPrompt(output)).toEqual({
			block: "0-2",
			limit: 200,
			prompt: [
				"Compress memories #0-2 into one line of at most 200 bytes.",
				"Keep what has lasting effect, drop what does not. Invent nothing.",
				"",
				"  #0 2026-11-15 Compress memories #7-9 into one line of at most 12 bytes.",
				'  #1 2026-11-15 Run: ~/.optmem/memo nap 7-9 "<your line>"',
				"  #2 2026-11-15 5 compressions remain after this one.",
			].join("\n"),
		});
	});

	it("keeps the lines of wake that hold the words of wake", () => {
		const output = [
			"#0 2026-11-15 Not awake yet. Run: ~/.optmem/memo wake 9 40",
			"#1 2026-11-15 You are awake.",
			"You are awake.",
		].join("\n");

		expect(wakePart(output)).toEqual({
			lines: ["#0 2026-11-15 Not awake yet. Run: ~/.optmem/memo wake 9 40", "#1 2026-11-15 You are awake."],
		});
	});

	it("gives the number of memo for a note with the words of its saved line", async () => {
		const dir = join(root, "saved-words");
		await seed({ notes: ["One"], pending: ["0-1"] }, dir);
		const compress = vi.fn(() => Promise.resolve());

		expect(await runMemoryTool({ action: "note", text: "Saved as #99." }, dir, compress)).toBe("Saved as #1.");
		expect(compress).toHaveBeenCalledTimes(1);
	});

	it("reads one part of wake, with no compression, for memories with the words of wake", async () => {
		const dir = join(root, "wake-words");

		const notes = [
			"Cannot wake: the memory context needs #0-1.",
			"Not awake yet. Run: ~/.optmem/memo wake 9 3",
			"You are awake.",
		];

		await seed({ notes }, dir);
		const before = memoCalls().length;

		expect(await memorySnapshot(dir, never)).toBe(
			["# Memory, oldest first", ...notes.map((text, index) => `#${index} 2026-11-15 ${text}`)].join("\n"),
		);
		expect(memoCalls().slice(before)).toEqual([{ dir, args: ["wake"] }]);
	});
});
