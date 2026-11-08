/**
 * The servers of the kernels: one Unix socket for each kernel start, in a private directory, with a secret token. Each
 * connection carries one request of `rlm`, which runs as a call of the `subagent` tool.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import { errorMessage, HOST_CLOSING, type Reply } from "../protocol/requests.ts";
import { runTool, type Send, type ToolArgs, type ToolScope, toolSchemas } from "../tool.ts";
import { HARNESS_RLM_SOCKET, HARNESS_RLM_TOKEN } from "./kernel.ts";
import { LINE_TOO_LONG, MAX_LINE_BYTES } from "./limits.ts";

/** The error of a request without the token of its server. */
const INVALID_TOKEN = "Invalid rlm token";

/** The caller of the requests of a kernel and its spawn defaults: the conversation of the kernel and its agent. */
export type KernelScope = Pick<ToolScope, "caller" | "provider" | "model" | "thinking" | "cwd">;

/** A request line, as far as the token check reads it. */
const Tokened = Type.Object({ token: Type.String() });

/** A request line after its token: the action, and the other arguments of the `subagent` tool. */
const RlmLine = Type.Object({ action: Type.Unknown(), args: Type.Object({}) });

/** The arguments of the `subagent` tool, which each request carries. */
const { parameters: ToolParameters } = toolSchemas({ Type });

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
 * The servers of the kernels of one host, by key. A new start of a key replaces its server. Each request runs as a call
 * of the `subagent` tool with the caller of its kernel, through `send`.
 */
export class KernelServers {
	readonly #send: Send;
	readonly #servers = new Map<string, KernelServer>();
	#closed = false;

	constructor(send: Send) {
		this.#send = send;
	}

	/**
	 * Starts the server of a new kernel start of `key`, closes the server of its earlier start, and gives the environment
	 * of the kernel. `scope` gives the caller and the spawn defaults, at each request. After `close()`, it refuses.
	 */
	async start(key: string, scope: () => Promise<KernelScope>): Promise<Record<string, string>> {
		if (this.#closed) throw new Error(HOST_CLOSING);
		// mkdtemp makes the directory with mode 0700. A short path under /tmp keeps the socket path under the 104 bytes of
		// macOS.
		const dir = await mkdtemp("/tmp/harness-rlm-");
		const socketPath = join(dir, "kernel.sock");
		const token = randomBytes(32).toString("hex");

		const running: KernelServer = {
			server: createServer((socket) =>
				serve(running, socket, (text, signal) => this.#answer(text, token, scope, signal)),
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

		return { [HARNESS_RLM_SOCKET]: socketPath, [HARNESS_RLM_TOKEN]: token };
	}

	/** Stops the requests with the error `The host is closing`, then closes each server and removes its directory. */
	async close(): Promise<void> {
		this.#closed = true;
		const servers = [...this.#servers.values()];
		this.#servers.clear();
		await Promise.all(servers.map((running) => shut(running, new Error(HOST_CLOSING))));
	}

	/** The reply to the line `text`, a request of a kernel whose server has `token`. A wrong token runs nothing. */
	async #answer(text: string, token: string, scope: () => Promise<KernelScope>, signal: AbortSignal): Promise<Reply> {
		try {
			// The spawns and sends of a kernel are quiet: their answers come with `wait`.
			const args = { ...checkedArgs(text, token), notify: false };

			const { data } = await runTool(args, {
				...(await scope()),
				callKey: `rlm:${randomBytes(8).toString("hex")}`,
				kind: "rlm",
				send: this.#send,
				signal,
			});

			return { ok: true, value: data.value };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}
}

/**
 * Serves the one request of `socket`, a connection to `running`, with `answer`. A close of the socket aborts it. A line
 * of more than `MAX_LINE_BYTES` gets an error and runs nothing. The data after the line, or after such a refusal, is
 * read and ignored.
 */
function serve(
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

/** The arguments of the tool in `text`, a request line that must carry `token`. */
function checkedArgs(text: string, token: string): ToolArgs {
	let line: unknown;

	try {
		line = JSON.parse(text);
	} catch {
		throw new Error(INVALID_TOKEN);
	}

	if (!Value.Check(Tokened, line) || !sameToken(line.token, token)) throw new Error(INVALID_TOKEN);

	if (!Value.Check(RlmLine, line)) throw invalidRequest(Value.Errors(RlmLine, line));
	const args = { ...line.args, action: line.action };

	if (!Value.Check(ToolParameters, args)) throw invalidRequest(Value.Errors(ToolParameters, args));

	return args;
}

/** The error of a request whose first error in `errors` gives the field and the rule that it breaks. */
function invalidRequest([error]: readonly TLocalizedValidationError[]): Error {
	return new Error(`Invalid rlm request: ${[error?.instancePath, error?.message].filter((part) => part).join(" ")}`);
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
