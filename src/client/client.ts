import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { JsonValue } from "@earendil-works/chord/json";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MAIN_HOST, hostOf } from "../protocol/hosts.ts";
import { onLines } from "../protocol/lines.ts";
import { cliPath, statePaths } from "../protocol/paths.ts";
import {
	type EntryRequestLine,
	errorMessage,
	HOST_CLOSING,
	PROTOCOL_VERSION,
	type Replies,
	type Request,
	STORE_LOCK_WAIT_MS,
	versionMismatch,
	type WatchLine,
} from "../protocol/requests.ts";
import { type Target, targetRef } from "../protocol/target.ts";

/** The error of each request of a client whose connection closed. */
export const HOST_CLOSED = "The harness host closed the connection";

/**
 * The error of a request that no host answered: no host could start, the connection closed or the host was closing, or
 * the host speaks another protocol version.
 */
export class HostUnreachableError extends Error {}

/**
 * Whether `error` failed a request because its host stopped: the host was closing, or the connection closed.
 */
export function hostStopped(error: unknown): error is Error {
	return error instanceof Error && (error.message === HOST_CLOSING || error.message === HOST_CLOSED);
}

const START_TIMEOUT_MS = 10_000;

/** The least time between two starts of a host by one client. */
const RESTART_INTERVAL_MS = 1000;

/** The waits before the tries to connect again after the host closed a long-lived connection. */
export const RETRY_DELAYS_MS: readonly number[] = [0, 2000, 5000];

/** A connection that ends sooner than this after it was opened again shows a host that fails at each start. */
export const SHORT_CONNECTION_MS = 10_000;

/**
 * The result of the first `attempt` that succeeds, with one try after each delay of `delays`. It is the error of the
 * last try when all fail. When `signal` aborts, it stops trying.
 */
export async function tryEach<T>(
	delays: readonly number[],
	signal: AbortSignal,
	attempt: () => Promise<T>,
): Promise<T | Error> {
	let error = new Error("Could not connect to the harness host");

	for (const delay of delays) {
		if (delay > 0) await sleep(delay, undefined, { signal }).catch(() => {});

		if (signal.aborted) break;

		try {
			return await attempt();
		} catch (cause) {
			error = new Error(errorMessage(cause));
		}
	}

	return error;
}

/** A line from the host: a reply, or an event of the watch. The value of a reply and the event are not checked here. */
const HostLine = Type.Union([
	Type.Object({ ok: Type.Literal(true), value: Type.Optional(Type.Unknown()) }),
	Type.Object({ ok: Type.Literal(false), error: Type.String() }),
	Type.Object({ event: Type.Unknown() }),
]);

/** The line `line` from the host, or undefined when it is not JSON or not a valid line. */
function parseLine(line: string): Static<typeof HostLine> | undefined {
	let parsed: unknown;

	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}

	return Value.Check(HostLine, parsed) ? parsed : undefined;
}

/**
 * A connection to the host. Requests are answered in order, one reply line for each request line. After `watch`, the
 * event lines of the watch come between the replies.
 */
export class Client {
	readonly #socket: Socket;
	readonly #pending: PromiseWithResolvers<unknown>[] = [];
	#ended = false;
	/** The events of the watch. Only `watch` sets it; otherwise an event is dropped. */
	#lines: Readable | undefined;
	/** The process ID of the host, from its `hello` reply. */
	pid = 0;
	/** The name of the host. `connect` sets it. */
	host = MAIN_HOST;

	constructor(socket: Socket) {
		this.#socket = socket;
		onLines(socket, (line) => {
			if (this.#ended) return;
			const parsed = parseLine(line);

			// A line that is not valid cannot be matched to its request, so no later reply can be either.
			if (parsed === undefined) {
				this.abort(new Error(`The harness host sent an invalid reply: ${line}`));

				return;
			}

			if ("event" in parsed) {
				this.#lines?.push(parsed.event);

				return;
			}

			const waiter = this.#pending.shift();

			if (waiter === undefined) return;

			if (parsed.ok) waiter.resolve(parsed.value);
			else if (parsed.error === HOST_CLOSING) waiter.reject(new HostUnreachableError(parsed.error));
			else waiter.reject(new Error(parsed.error));
		});
		socket.on("error", () => this.#end());
		socket.on("close", () => this.#end());
	}

	/** Whether the connection closed. A request that failed then may have reached the host or not. */
	get ended(): boolean {
		return this.#ended;
	}

	request<T extends Request["type"]>(request: Extract<Request, { type: T }>): Promise<Replies[T]> {
		return this.#send<Replies[T]>(request);
	}

	/**
	 * Sends `request`, of a type that an entry serves, such as `parley` of the projects entry, and gives the value of its
	 * reply, which the caller checks. Without an entry that serves its type, the host refuses it.
	 */
	requestEntry(request: EntryRequestLine): Promise<JsonValue> {
		return this.#send<JsonValue>(request);
	}

	/** Writes `line`, and gives the value of its reply, `R`, in the order of the requests. */
	#send<R>(line: { readonly type: string }): Promise<R> {
		if (this.#ended) return Promise.reject(new HostUnreachableError(HOST_CLOSED));

		const reply = Promise.withResolvers<unknown>();
		this.#pending.push(reply);
		this.#socket.write(`${JSON.stringify(line)}\n`);

		// SAFETY: the host answers each request line in order with the value of `Replies` for its type, `connect` refuses a
		// host of another protocol version, and the value of the reply to a request of an entry is JSON, which `R` is.
		return reply.promise as Promise<R>;
	}

	/**
	 * Sends the `watch` request of `target`. Its `lines` are the events of the watch, and end when the connection closes.
	 * Other requests can follow on this client. Call it once.
	 */
	async watch(target: Target): Promise<Replies["watch"] & { lines: AsyncIterable<WatchLine> }> {
		const lines = new Readable({ objectMode: true, read() {} });
		this.#lines = lines;

		const reply = await this.request({ type: "watch", ...targetRef(target) });

		return { ...reply, lines };
	}

	close(): void {
		this.#socket.end();
	}

	/** Rejects the pending requests with `cause` and closes the connection. The host then stops them. */
	abort(cause: unknown): void {
		this.#end(cause);
		this.#socket.destroy();
	}

	#end(cause: unknown = new HostUnreachableError(HOST_CLOSED)): void {
		if (!this.#ended) this.#lines?.push(null);
		this.#ended = true;

		for (const waiter of this.#pending.splice(0)) waiter.reject(cause);
	}
}

/**
 * A connection to the host `host`, else to the host of `HARNESS_HOST` or the cwd (see `hostOf`), after its `hello`.
 * When no host listens and `start` is true, it starts one (see `startAndConnect`). When no host listens and `start` is
 * false, it is undefined. It fails with `HostUnreachableError` when no host answers its `hello`, or when the host has
 * another protocol version, unless `signal` aborted.
 */
export async function connect(options: ConnectOptions): Promise<Client | undefined> {
	const host = hostOf(options.host, process.env, process.cwd());

	try {
		return await connectTo(host, options);
	} catch (error) {
		throw options.signal?.aborted ? error : new HostUnreachableError(errorMessage(error), { cause: error });
	}
}

/** `connect` to the host `host`, with the errors of each step. */
async function connectTo(host: string, options: ConnectOptions): Promise<Client | undefined> {
	const paths = statePaths(host);
	let socket = await tryConnect(paths.socket);

	if (socket === undefined) {
		if (!options.start) return undefined;
		socket = await startAndConnect(host, paths, options.signal);
	}

	const client = new Client(socket);

	try {
		const hello = await client.request({ type: "hello", version: PROTOCOL_VERSION });

		if (hello.version !== PROTOCOL_VERSION) {
			throw new Error(versionMismatch(PROTOCOL_VERSION, hello.version, hello.pid));
		}

		client.pid = hello.pid;
		client.host = host;

		return client;
	} catch (error) {
		client.close();
		throw error;
	}
}

type ConnectOptions = {
	readonly start: boolean;
	readonly signal?: AbortSignal | undefined;
	/** `main` or a host name. Without it, the host comes from `HARNESS_HOST` and the cwd. */
	readonly host?: string | undefined;
};

type OneShot<T extends Request["type"]> = Extract<Request, { type: T }>;

/**
 * Connects as `connect` does, sends `request`, and closes the connection. It is undefined when no host listens and
 * `start` is false. When `signal` aborts, it rejects with the abort reason, and the host stops the request.
 */
export function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: ConnectOptions & { readonly start: true },
): Promise<Replies[T]>;
export function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: ConnectOptions,
): Promise<Replies[T] | undefined>;
export async function request<T extends Request["type"]>(
	request: OneShot<T>,
	options: ConnectOptions,
): Promise<Replies[T] | undefined> {
	return oneShot(options, (client) => client.request(request));
}

/**
 * Sends `request`, of a type that an entry serves, as `request` does a request of the host, and gives the value of its
 * reply, which the caller checks. It is undefined when no host listens and `start` is false.
 */
export function requestEntry(
	request: EntryRequestLine,
	options: ConnectOptions & { readonly start: true },
): Promise<JsonValue>;
export function requestEntry(request: EntryRequestLine, options: ConnectOptions): Promise<JsonValue | undefined>;
export async function requestEntry(request: EntryRequestLine, options: ConnectOptions): Promise<JsonValue | undefined> {
	return oneShot(options, (client) => client.requestEntry(request));
}

/**
 * Connects as `connect` does, runs `send` on the client, and closes the connection. It is undefined when no host
 * listens and `start` is false. When `signal` aborts, it rejects with the abort reason, and the host stops the request.
 */
async function oneShot<R>(options: ConnectOptions, send: (client: Client) => Promise<R>): Promise<R | undefined> {
	const { signal } = options;
	const client = await connect(options);

	if (client === undefined) return undefined;
	const abort = () => client.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });

	try {
		signal?.throwIfAborted();

		return await send(client);
	} finally {
		signal?.removeEventListener("abort", abort);
		client.close();
	}
}

/** The connected socket, or undefined when nothing listens at `path`. */
function tryConnect(path: string): Promise<Socket | undefined> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.removeAllListeners("error");
			resolve(socket);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined);
			else reject(error);
		});
	});
}

/**
 * Starts the host `name`, detached, with its output in `host.log`, and connects to it, for 10 s, or until `signal`
 * aborts. A started host that exits with code 0 found the lock held, such as by a host that closes on idle and has not
 * released its lock yet, so it starts a host again, at most once per second. Another exit fails at once.
 */
async function startAndConnect(
	name: string,
	paths: ReturnType<typeof statePaths>,
	signal: AbortSignal | undefined,
): Promise<Socket> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	const hostArgs = ["--host", name, "host"];
	let host = startDetached(hostArgs, paths.dir, paths.log);

	for (;;) {
		signal?.throwIfAborted();
		const socket = await tryConnect(paths.socket);

		if (socket !== undefined) return socket;
		const { exited } = host;

		if (exited !== undefined && !("code" in exited && exited.code === 0)) {
			throw new Error(`The harness host exited with ${exitText(exited)}; see ${paths.log}`);
		}

		if (exited !== undefined && Date.now() - host.startedAt >= RESTART_INTERVAL_MS) {
			host = startDetached(hostArgs, paths.dir, paths.log);
		}

		if (Date.now() > deadline) {
			// A host that runs and does not listen yet is still in its start, such as in the wait for its store's lock.
			throw new Error(
				host.exited === undefined
					? `The harness host (pid ${host.pid}) is still starting: it can wait up to ${STORE_LOCK_WAIT_MS / 1000} s for the lock of durable.sqlite. Run the command again soon; see ${paths.log}`
					: `Could not start the harness host; see ${paths.log}`,
			);
		}

		await sleep(100);
	}
}

/** A process that `startDetached` started. */
export type StartedProcess = {
	readonly pid: number | undefined;
	readonly startedAt: number;
	/** How the process ended, or undefined while it runs. */
	exited: ProcessExit | undefined;
};

/** The end of a started process: its exit code or signal, or the error that kept it from running. */
type ProcessExit =
	| { readonly code: number | null; readonly signal: NodeJS.Signals | null }
	| { readonly error: string };

export function exitText(exited: ProcessExit): string {
	if ("error" in exited) return `error ${exited.error}`;

	return exited.code === null ? `signal ${exited.signal}` : `code ${exited.code}`;
}

/**
 * Starts the CLI of this install with `args` and this Node, detached, in the folder `dir`, which it creates, with its
 * output appended to `log`.
 */
export function startDetached(args: readonly string[], dir: string, log: string): StartedProcess {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const output = openSync(log, "a", 0o600);

	try {
		const child = spawn(process.execPath, [cliPath(), ...args], {
			cwd: dir,
			detached: true,
			stdio: ["ignore", output, output],
		});

		child.unref();
		const started: StartedProcess = { pid: child.pid, startedAt: Date.now(), exited: undefined };

		child.once("exit", (code, signal) => {
			started.exited = { code, signal };
		});
		child.once("error", (error) => {
			started.exited = { error: error.message };
		});

		return started;
	} finally {
		closeSync(output);
	}
}
