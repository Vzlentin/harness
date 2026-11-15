/**
 * The `memo` program of OptMem in the host: the runner of the `memory` tool, and the readers of the outputs of `memo`,
 * the compression prompts and the parts of a wake.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { MemoryToolArgs } from "../memory-tool.ts";
import { NO_ABORT, required } from "../tool.ts";

/** The heading of the memory section of the system prompt. */
const MEMORY_HEADING = "# Memory, oldest first";

/**
 * Runs one call of the `memory` tool on the memory `dir`, which is undefined for OptMem's own default folder,
 * `~/.optmem/memory`. A note whose output has a compression prompt calls `compress`, and does not wait for it.
 */
export async function runMemoryTool(
	args: MemoryToolArgs,
	dir: string | undefined,
	compress: () => Promise<void>,
	signal?: AbortSignal,
): Promise<string> {
	const { action } = args;

	switch (action) {
		case "note": {
			const output = await runMemo(["note", required(args.text, "text", action).trim()], dir, signal);

			if (napPrompt(output) !== undefined) void compress();
			const saved = /^Saved as #\d+\.$/m.exec(output)?.[0];

			if (saved === undefined) throw new Error("memo note gave no `Saved as #<N>.` line");

			return saved;
		}

		case "recall":
			return runMemo(["recall", required(args.pattern, "pattern", action)], dir, signal);

		case "zoom":
			return runMemo(["zoom", required(args.block, "block", action)], dir, signal);

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

/** The `memo` of OptMem, read at each call from the home directory of now. */
function memoPath(): string {
	return join(homedir(), ".optmem", "memo");
}

/** The error of a program that does not exist. */
const Missing = Type.Object({ code: Type.Literal("ENOENT") });

/**
 * The output of `memo` with `args`, on the memory `dir`. It throws the error output of `memo`, else its output, since
 * `memo` prints `Cannot wake` on its output with the exit code 1.
 */
export function runMemo(
	args: readonly string[],
	dir: string | undefined,
	signal: AbortSignal = NO_ABORT,
): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env };

	if (dir === undefined) delete env.MEMORY_DIR;
	else env.MEMORY_DIR = dir;

	return new Promise((resolve, reject) => {
		execFile(
			memoPath(),
			args,
			{ env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal },
			(error, stdout, stderr) => {
				if (error === null) return resolve(stdout);

				if (Value.Check(Missing, error)) return reject(new Error("~/.optmem/memo is missing: install OptMem"));
				reject(new Error(stderr.trim() || stdout.trim() || error.message));
			},
		);
	});
}

/** A compression that a memory waits for: its block, the most bytes of its line, and the prompt for a model. */
export type NapPrompt = { readonly block: string; readonly limit: number; readonly prompt: string };

const NAP_LINE = /^Compress memories #(\d+-\d+) into one line of at most (\d+) bytes\./m;

/**
 * The compression prompt in the output of `memo`, if any. The prompt keeps the memories to compress, and drops the
 * count of the compressions left and the `memo nap` command.
 */
export function napPrompt(output: string): NapPrompt | undefined {
	const found = NAP_LINE.exec(output);

	if (found === null) return undefined;
	const [, block = "", limit = ""] = found;
	const lines = output.slice(found.index).split("\n");
	const end = lines.findIndex((text) => text.startsWith("Run: "));

	const prompt = (end === -1 ? lines : lines.slice(0, end))
		.filter((text) => !/^\d+ compressions? remains? after this one\.$/.test(text))
		.join("\n")
		.trim();

	return { block, limit: Number(limit), prompt };
}

/** One part of the output of `memo wake`: its memory lines, and the part and snapshot of the next part, if any. */
export type WakePart = {
	readonly lines: readonly string[];
	readonly next?: { readonly part: number; readonly at: number };
};

const NEXT_PART = /^Not awake yet\. Run: .* wake (\d+) (\d+)$/m;

/** The memory lines of `output`, a part of `memo wake`, and the next part to read. */
export function wakePart(output: string): WakePart {
	const lines: string[] = [];

	for (const line of output.split("\n")) {
		if (line === "You are awake." || NEXT_PART.test(line)) break;

		if (line.startsWith("#")) lines.push(line);
	}

	const next = NEXT_PART.exec(output);

	return next === null ? { lines } : { lines, next: { part: Number(next[1]), at: Number(next[2]) } };
}

/**
 * The memory `dir` as the text of the memory section: the heading, then every line of each part of `memo wake`, oldest
 * first. Undefined for an empty memory. When `wake` cannot run until a compression is done, it awaits `compress` of the
 * memory `dir`, then runs `wake` one more time.
 */
export async function memorySnapshot(
	dir: string | undefined,
	compress: () => Promise<void>,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const wake = async (args: readonly string[]) => wakePart(await runMemo(["wake", ...args], dir, signal));

	let part: WakePart;

	try {
		part = await wake([]);
	} catch (cause) {
		if (!(cause instanceof Error && cause.message.startsWith("Cannot wake"))) throw cause;
		await compress();
		part = await wake([]);
	}

	const lines = [...part.lines];

	while (part.next !== undefined) {
		part = await wake([String(part.next.part), String(part.next.at)]);
		lines.push(...part.lines);
	}

	return lines.length === 0 ? undefined : [MEMORY_HEADING, ...lines].join("\n");
}
