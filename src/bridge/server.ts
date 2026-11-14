/**
 * The servers of the kernels: one Unix socket for each kernel start, in a private directory, with a secret token. Each
 * connection carries one request of `tools`, which runs a tool of the oldest open cell of the kernel.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import { errorMessage, HOST_CLOSING, type Reply } from "../protocol/requests.ts";
import { HARNESS_TOOLS_SOCKET, HARNESS_TOOLS_TOKEN, type KernelStarting, STARTUP_CODE } from "./kernel.ts";

/** The error of a request without the token of its server. */
const INVALID_TOKEN = "Invalid tools token";

/**
 * The UTF-8 bytes of a request line, before its newline. It bounds the transport only: it stops a line that has no end,
 * and is above any input that a model can give.
 */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

const LINE_TOO_LONG = "Invalid tools request: the line is longer than 16 MiB";

/** The error of a call while no cell of its kernel runs. */
const NO_CELL = "No cell of this kernel runs: tools runs a tool only while a cell runs";

/** The error of a call whose cell ended while it ran. */
const CELL_ENDED = "The cell ended: tools runs a tool only while a cell runs";

/** The tool of the cells. A cell cannot call it: its kernel is busy with the cell, so the call would never start. */
const IPYTHON = "ipython";

const NO_IPYTHON = "A cell cannot run ipython: its kernel is busy with the cell";

/**
 * The prefix of the internal tools of pi-durable's code mode, `CODEMODE_INTERNAL_PREFIX`, which it does not export.
 * Code mode hides them from scripts, and the bridge hides them from cells.
 */
const CODEMODE_INTERNAL_PREFIX = "pi.codemode.";

/**
 * A tool of the conversation of a cell: its name, its description, the JSON Schema of its arguments, whether it has a
 * schema for its output, and whether it is deferred, that is, not offered until a tool search loads it.
 */
export type BridgeTool = {
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
	/** True when the tool has a schema for its structured output: a call then gives that output, not the text. */
	readonly structured: boolean;
	readonly deferred?: boolean | undefined;
};

/** What a running cell gives the bridge: the tools of its conversation. */
export type Cell = {
	/**
	 * Runs `tool`, one of `tools()`, with `args`, and gives its structured output when `tool.structured`, else its text.
	 * A failed call throws, with the error text of the tool. `signal` aborts the call.
	 */
	call(tool: BridgeTool, args: JsonObject, signal: AbortSignal): Promise<JsonValue>;
	/** The tools of the conversation of the cell, hidden ones too (see `refusal`). */
	tools(): Promise<readonly BridgeTool[]>;
};

/** A tool in the list reply: only what Python reads to make its tool. */
type ListedTool = Pick<BridgeTool, "name" | "description" | "parameters">;

/** A cell that runs, from its start to its end. Its end aborts `abort`. */
type OpenCell = { readonly id: string; readonly cell: Cell; readonly abort: AbortController };

/** A request line, as far as the token check reads it. */
const Tokened = Type.Object({ token: Type.String() });

/** A request line after its token: a call of the tool `name` with `args`, or without `name`, the list of the tools. */
const ToolsLine = Type.Object({
	name: Type.Optional(Type.String()),
	// The line is parsed JSON, so its values are JSON values.
	args: Type.Optional(Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Unknown()))),
});

type ToolsLine = Static<typeof ToolsLine>;

/** The server of one kernel start. */
type KernelServer = {
	readonly server: Server;
	readonly dir: string;
	readonly connections: Set<Socket>;
	readonly aborts: Set<AbortController>;
	/** The requests in flight, until their reply is handed to the socket. */
	readonly inFlight: Set<Promise<void>>;
};

/**
 * The servers of the kernels of one host or one Pi session, and their open cells, by key. A new start of a key replaces
 * its server. Each request runs with the oldest open cell of its key: a kernel runs one cell at a time.
 */
export class KernelServers {
	readonly #servers = new Map<string, KernelServer>();
	readonly #cells = new Map<string, OpenCell[]>();
	#closed = false;

	/**
	 * Starts the server of the kernel start `starting` of `key`, closes the server of its earlier start, then gives the
	 * kernel its environment and the startup code that binds `tools`. After `close()`, it refuses with `The host is
	 * closing`.
	 */
	async serve(starting: Pick<KernelStarting, "env" | "startupCode">, key: string): Promise<void> {
		if (this.#closed) throw new Error(HOST_CLOSING);
		// mkdtemp makes the directory with mode 0700. A short path under /tmp keeps the socket path under the 104 bytes of
		// macOS.
		const dir = await mkdtemp("/tmp/harness-tools-");
		const socketPath = join(dir, "kernel.sock");
		const token = randomBytes(32).toString("hex");

		const running: KernelServer = {
			server: createServer((socket) =>
				serveConnection(running, socket, (text, signal) => this.#answer(text, token, key, signal)),
			),
			dir,
			connections: new Set(),
			aborts: new Set(),
			inFlight: new Set(),
		};

		try {
			await new Promise<void>((resolveListen, rejectListen) => {
				running.server.once("error", rejectListen);
				running.server.listen(socketPath, () => {
					running.server.off("error", rejectListen);
					resolveListen();
				});
			});
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			throw error;
		}

		if (this.#closed) {
			await shut(running, new Error(HOST_CLOSING));
			throw new Error(HOST_CLOSING);
		}

		const old = this.#servers.get(key);
		this.#servers.set(key, running);

		if (old !== undefined) await shut(old, new Error("The kernel started again"));
		Object.assign(starting.env, { [HARNESS_TOOLS_SOCKET]: socketPath, [HARNESS_TOOLS_TOKEN]: token });
		starting.startupCode.push(...STARTUP_CODE);
	}

	/** Opens the cell `id` of the kernel of `key`, which `cell` serves until `end`. After `close()`, it does nothing. */
	open(key: string, id: string, cell: Cell): void {
		if (this.#closed) return;
		this.#cells.set(key, [...(this.#cells.get(key) ?? []), { id, cell, abort: new AbortController() }]);
	}

	/** Ends the cell `id` of the kernel of `key`, or without `id`, its oldest open cell, and stops the calls of that cell. */
	end(key: string, id?: string): void {
		const open = this.#cells.get(key) ?? [];
		const index = id === undefined ? 0 : open.findIndex((cell) => cell.id === id);
		const [ended] = index === -1 ? [] : open.splice(index, 1);

		if (open.length === 0) this.#cells.delete(key);
		ended?.abort.abort(new Error(CELL_ENDED));
	}

	/** Stops the requests with the error `The host is closing`, then closes each server and removes its directory. */
	async close(): Promise<void> {
		this.#closed = true;
		const cells = [...this.#cells.values()].flat();
		this.#cells.clear();

		for (const { abort } of cells) abort.abort(new Error(HOST_CLOSING));
		const servers = [...this.#servers.values()];
		this.#servers.clear();
		await Promise.all(servers.map((running) => shut(running, new Error(HOST_CLOSING))));
	}

	/**
	 * The reply to the line `text`, a request of the kernel of `key`, whose server has `token`. A wrong token runs
	 * nothing. The request stops when `signal` aborts or its cell ends, also when the tool goes on.
	 */
	async #answer(text: string, token: string, key: string, signal: AbortSignal): Promise<Reply> {
		try {
			const line = checkedLine(text, token);
			const open = this.#cells.get(key)?.[0];

			if (open === undefined) throw new Error(NO_CELL);
			const stop = AbortSignal.any([signal, open.abort.signal]);

			return { ok: true, value: await untilAborted(run(open.cell, line, stop), stop) };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}
}

/** Runs the request `line` with `cell`: the call of a tool, or the list of the tools that a cell can call. */
async function run(cell: Cell, line: ToolsLine, signal: AbortSignal): Promise<JsonValue | readonly ListedTool[]> {
	const tools = await cell.tools();

	if (line.name === undefined)
		return tools
			.filter((tool) => refusal(tool) === undefined)
			.map(({ name, description, parameters }) => ({ name, description, parameters }));
	const { name } = line;
	const tool = tools.find((candidate) => candidate.name === name);

	if (tool === undefined) throw new Error(`Tool ${name} is not available`);
	const refused = refusal(tool);

	if (refused !== undefined) throw new Error(refused);

	return cell.call(tool, line.args ?? {}, signal);
}

/**
 * Why a cell cannot call `tool`, or `undefined` when it can. A cell cannot call `ipython`, the internal tools of code
 * mode, or a deferred tool. Code mode leaves the last two out of the tools that it lists to a script.
 */
function refusal(tool: BridgeTool): string | undefined {
	if (tool.name === IPYTHON) return NO_IPYTHON;

	if (tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) || tool.deferred === true)
		return `Tool ${tool.name} is not available`;

	return undefined;
}

/** `work`, or a rejection with the reason of `signal` once it aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();

	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
	});
}

/**
 * Serves the one request of `socket`, a connection to `running`, with `answer`. A close of the socket aborts it. A line
 * of more than `MAX_LINE_BYTES`, 16 MiB, gets an error and runs nothing. The data after the line, or after such a refusal, is
 * read and ignored.
 */
function serveConnection(
	running: KernelServer,
	socket: Socket,
	answer: (text: string, signal: AbortSignal) => Promise<Reply>,
): void {
	running.connections.add(socket);
	const abort = new AbortController();
	running.aborts.add(abort);
	const chunks: Buffer[] = [];
	let size = 0;
	let served = false;

	socket.on("data", (chunk: Buffer) => {
		if (served) return;
		const newline = chunk.indexOf(0x0a);
		const part = newline === -1 ? chunk : chunk.subarray(0, newline);
		size += part.length;

		if (size > MAX_LINE_BYTES) {
			served = true;
			chunks.length = 0;
			socket.end(`${JSON.stringify({ ok: false, error: LINE_TOO_LONG } satisfies Reply)}\n`);

			return;
		}

		chunks.push(part);

		if (newline === -1) return;
		served = true;
		const text = Buffer.concat(chunks).toString("utf8");
		chunks.length = 0;

		const request = answer(text, abort.signal).then((reply) => {
			if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
		});

		const settle = () => running.inFlight.delete(request);
		running.inFlight.add(request);
		request.then(settle, settle);
	});
	socket.on("error", () => socket.destroy());
	socket.on("close", () => {
		running.connections.delete(socket);
		running.aborts.delete(abort);
		abort.abort();
	});
}

/** The request in `text`, a line that must carry `token`. */
function checkedLine(text: string, token: string): ToolsLine {
	let line: unknown;

	try {
		line = JSON.parse(text);
	} catch {
		throw new Error(INVALID_TOKEN);
	}

	if (!Value.Check(Tokened, line) || !sameToken(line.token, token)) throw new Error(INVALID_TOKEN);

	if (!Value.Check(ToolsLine, line)) throw invalidRequest(Value.Errors(ToolsLine, line));

	return line;
}

/** The error of a request whose first error in `errors` gives the field and the rule that it breaks. */
function invalidRequest([error]: readonly TLocalizedValidationError[]): Error {
	return new Error(`Invalid tools request: ${[error?.instancePath, error?.message].filter((part) => part).join(" ")}`);
}

function sameToken(given: string, token: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(token);

	return a.length === b.length && timingSafeEqual(a, b);
}

/** Closes the server of `running`: it stops listening, stops the requests with `reason`, and removes the directory. */
async function shut(running: KernelServer, reason: Error): Promise<void> {
	running.server.close();

	for (const abort of running.aborts) abort.abort(reason);

	// Each request reads its signal, so this needs no timeout.
	while (running.inFlight.size > 0) await Promise.allSettled(running.inFlight);

	// A socket ends once its reply is written.
	for (const socket of running.connections) socket.destroySoon();
	await rm(running.dir, { recursive: true, force: true });
}
