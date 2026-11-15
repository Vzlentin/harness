/**
 * The memory of the project agent: the `memory` tool, the memory section of its system prompt, and the compressor that
 * answers the compression prompts of OptMem in the background with a model of Pi's settings.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type ConversationId, defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { memoryTool } from "../memory-tool.ts";
import { MEMORY_EXTENSION, MEMORY_SECTION } from "../protocol/project.ts";
import { errorMessage } from "../protocol/requests.ts";
import { settingModel } from "./model-choice.ts";
import { memorySnapshot, type NapPrompt, napPrompt, runMemo, runMemoryTool } from "./optmem.ts";

const SYSTEM_PROMPT = `You compress the memories of an agent into one line.
Answer with the line only: no quotes, no heading, no comment.`;

/** One compression loop of a memory folder, and whether a note asked for one more pass while it ran. */
type Loop = { again: boolean; done: Promise<void> };

/** What the compressor uses of the host. */
export type CompressorHost = {
	/** Pi's settings, for `memoryModel` and the default model. */
	readonly settings: SettingsManager;
	readonly models: Models;
	readonly warn: (cause: unknown) => void;
};

/**
 * Answers the compression prompts of each memory folder: it runs `memo nap`, asks the model of `memoryModel` (else
 * `subagentModel`, else Pi's default model) at thinking low for each prompt, and saves its line with `memo nap a-b`.
 * One loop runs for each folder at a time. A failure gives one warning and ends the loop.
 */
export class Compressor {
	readonly #host: CompressorHost;
	readonly #abort = new AbortController();
	/** The loop that runs for each memory folder, by folder; `""` is OptMem's own default folder. */
	readonly #loops = new Map<string, Loop>();

	constructor(host: CompressorHost) {
		this.#host = host;
	}

	/** The number of loops that run. The host does not exit while one runs. */
	get running(): number {
		return this.#loops.size;
	}

	/** Aborted when the host closes. */
	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	/**
	 * Compresses the memory `dir` until it has no compression left. A call while its loop runs makes the loop run one
	 * more pass, and gives the end of that loop. It never rejects.
	 */
	compress(dir: string | undefined): Promise<void> {
		const key = dir ?? "";
		const known = this.#loops.get(key);

		if (known !== undefined) {
			known.again = true;

			return known.done;
		}

		if (this.#abort.signal.aborted) return Promise.resolve();
		const loop: Loop = { again: false, done: Promise.resolve() };
		loop.done = this.#run(dir, loop).finally(() => this.#loops.delete(key));
		this.#loops.set(key, loop);

		return loop.done;
	}

	/** Writes `cause` as a warning to the host's log, unless the host closes. */
	warn(cause: unknown): void {
		if (!this.#abort.signal.aborted) this.#host.warn(cause);
	}

	/** Stops the loops, and waits until they end. */
	async close(): Promise<void> {
		this.#abort.abort();
		await Promise.allSettled([...this.#loops.values()].map((loop) => loop.done));
	}

	async #run(dir: string | undefined, loop: Loop): Promise<void> {
		const { signal } = this.#abort;

		try {
			do {
				loop.again = false;
				let next = napPrompt(await runMemo(["nap"], dir, signal));

				while (next !== undefined) {
					const line = await this.#line(next, signal);
					next = napPrompt(await runMemo(["nap", next.block, line], dir, signal));
				}
			} while (loop.again);
		} catch (error) {
			this.warn(`A compression of the memory failed: ${errorMessage(error)}`);
		}
	}

	/** The line of the model for the compression `nap`, cut to its limit. */
	async #line(nap: NapPrompt, signal: AbortSignal): Promise<string> {
		const { settings, models } = this.#host;
		const model = await settingModel(settings, models, "memoryModel", "a compression");
		const message: Message = { role: "user", content: nap.prompt, timestamp: Date.now() };

		const reply = await models.completeSimple(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
			{ signal, reasoning: "low" },
		);

		const name = `${model.provider}/${model.id}`;

		if (reply.stopReason !== "stop") {
			throw new Error(`The memory model ${name} failed: ${reply.errorMessage ?? reply.stopReason}`);
		}

		const text = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

		const line = text
			.split("\n")
			.map((part) => part.trim())
			.find((part) => part !== "");

		if (line === undefined) throw new Error(`The memory model ${name} gave no line`);

		return cutLine(line, nap.limit);
	}
}

/** `line`, cut to at most `limit` bytes in UTF-8: at the end of a word, else at the end of a character. */
function cutLine(line: string, limit: number): string {
	const bytes = Buffer.from(line, "utf8");

	if (bytes.length <= limit) return line;
	let end = limit;

	// A UTF-8 continuation byte is `10xxxxxx`: the character that it is part of does not fit.
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	const cut = bytes.subarray(0, end).toString("utf8");

	if (bytes[end] === 0x20) return cut.trimEnd();
	const space = cut.lastIndexOf(" ");

	return space > 0 ? cut.slice(0, space).trimEnd() : cut;
}

/**
 * The extension of the memory of the project agent: the `memory` tool and the memory section. The memory folder is
 * `dir()`, read at each use. The section is a snapshot that is taken at the first request of each conversation and kept
 * for the life of the host. An empty memory gives no section; so does a failed snapshot, with one warning.
 */
export function memoryExtension(compressor: Compressor, dir: () => string | undefined): Extension {
	const tool = memoryTool({ Type }, (memory) =>
		defineTool({
			name: memory.name,
			description: memory.description,
			parameters: memory.parameters,
			replay: "unsafe",
			async execute(args, _api, context) {
				// pi-durable has validated the arguments, but its types do not narrow TypeBox schemas.
				if (!Value.Check(memory.parameters, args)) throw new Error("Invalid memory arguments");
				const folder = dir();
				const text = await runMemoryTool(args, folder, () => compressor.compress(folder), context.abortSignal);

				return { output: [{ type: "text", text }] };
			},
		}),
	);

	const snapshots = new Map<ConversationId, Promise<string | undefined>>();

	const render = (conversationId: ConversationId) => {
		const known = snapshots.get(conversationId);

		if (known !== undefined) return known;

		const folder = dir();
		const compress = () => compressor.compress(folder);

		const snapshot = memorySnapshot(folder, compress, compressor.signal).catch((cause: unknown) => {
			compressor.warn(`The memory section failed: ${errorMessage(cause)}`);

			return undefined;
		});

		snapshots.set(conversationId, snapshot);

		return snapshot;
	};

	return defineExtension({
		name: MEMORY_EXTENSION,
		tools: [tool],
		sections: [section(MEMORY_SECTION, (input) => render(input.conversationId))],
	});
}
