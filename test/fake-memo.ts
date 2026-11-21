/**
 * The fake `memo` of OptMem that the tests of the memory install in the home folder of the tests.
 */
import { readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./helpers.ts";

/**
 * A fake `memo` of OptMem at `$HOME/.optmem/memo`. It adds each call as `{ dir, args }` to `$HOME/.optmem/calls.log`,
 * where `dir` is `MEMORY_DIR` or null. Its memory folder is `MEMORY_DIR`, else `$HOME/.optmem/memory`, and keeps its
 * state in `state.json`: the notes, the queue of the blocks that wait for a compression, the summaries, the byte limit
 * of a compressed line, the byte limit of a note, the number of parts of a wake, and whether wake fails while a block waits. A nap fails while
 * `$HOME/.optmem/nap-fails` exists.
 */
export const FAKE_MEMO = `#!${process.execPath}
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
const save = () => {
	fs.writeFileSync(file + ".tmp", JSON.stringify(state));
	fs.renameSync(file + ".tmp", file);
};
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

export const optmem = () => join(root, "home", ".optmem");

export async function installMemo(): Promise<void> {
	await mkdir(optmem(), { recursive: true });
	await writeFile(join(optmem(), "memo"), FAKE_MEMO);
	await chmod(join(optmem(), "memo"), 0o755);
}

/** The memory folder `dir`, else the default folder of OptMem. */
export function folder(dir?: string): string {
	return dir ?? join(optmem(), "memory");
}

export type FakeState = {
	readonly notes?: readonly string[];
	readonly pending?: readonly string[];
	readonly summaries?: Readonly<Record<string, string>>;
	readonly limit?: number;
	readonly noteLimit?: number;
	readonly parts?: number;
	readonly cannotWake?: boolean;
};

export async function seed(state: FakeState, dir?: string): Promise<void> {
	await mkdir(folder(dir), { recursive: true });
	await writeFile(join(folder(dir), "state.json"), JSON.stringify(state));
}

export function readState(dir?: string): Required<FakeState> {
	return JSON.parse(readFileSync(join(folder(dir), "state.json"), "utf8"));
}

/** The calls of the fake memo, each as `{ dir, args }`. */
export function memoCalls(): { dir: string | null; args: string[] }[] {
	return readFileSync(join(optmem(), "calls.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
