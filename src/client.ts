import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { checkProject, MAIN_PROJECT, resolveProject } from "./projects.ts";
import {
	cliPath,
	errorMessage,
	onLines,
	PROTOCOL_VERSION,
	type Replies,
	type Request,
	STORE_LOCK_WAIT_MS,
	statePaths,
	type Target,
	versionMismatch,
	type WatchLine,
} from "./protocol.ts";

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
	/** The project of the host. `connect` sets it. */
	project = MAIN_PROJECT;

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
		if (this.#ended) return Promise.reject(new Error("The harness host closed the connection"));

		const reply = Promise.withResolvers<unknown>();
		this.#pending.push(reply);
		this.#socket.write(`${JSON.stringify(request)}\n`);

		// SAFETY: the host answers each request line in order with the value of `Replies` for its type, and `connect`
		// refuses a host of another protocol version.
		return reply.promise as Promise<Replies[T]>;
	}

	/**
	 * Sends the `watch` request of `target`, a handle or a conversation ID. Its `lines` are the events of the watch, and
	 * end when the connection closes. Other requests can follow on this client. Call it once.
	 */
	async watch(target: string | Target): Promise<Replies["watch"] & { lines: AsyncIterable<WatchLine> }> {
		const lines = new Readable({ objectMode: true, read() {} });
		this.#lines = lines;
		const ref = target instanceof Object ? target : { handle: target };

		const reply = await this.request({ type: "watch", ...ref });

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

	#end(cause: unknown = new Error("The harness host closed the connection")): void {
		if (!this.#ended) this.#lines?.push(null);
		this.#ended = true;

		for (const waiter of this.#pending.splice(0)) waiter.reject(cause);
	}
}

/**
 * A connection to the host of `project`, or of the project of `HARNESS_PROJECT` or the cwd (see `resolveProject`),
 * after its `hello`. When no host listens and `start` is true, it starts one (see `startAndConnect`). When no host
 * listens and `start` is false, it is undefined.
 */
export async function connect(options: ConnectOptions): Promise<Client | undefined> {
	const project =
		options.project === undefined ? resolveProject(process.env, process.cwd()) : checkProject(options.project);

	const paths = statePaths(project);
	let socket = await tryConnect(paths.socket);

	if (socket === undefined) {
		if (!options.start) return undefined;
		socket = await startAndConnect(project, paths, options.signal);
	}

	const client = new Client(socket);

	try {
		const hello = await client.request({ type: "hello", version: PROTOCOL_VERSION });

		if (hello.version !== PROTOCOL_VERSION) {
			throw new Error(versionMismatch(PROTOCOL_VERSION, hello.version, hello.pid));
		}

		client.pid = hello.pid;
		client.project = project;

		return client;
	} catch (error) {
		client.close();
		throw error;
	}
}

type ConnectOptions = {
	readonly start: boolean;
	readonly signal?: AbortSignal | undefined;
	/** `main` or a project name. Without it, the project comes from `HARNESS_PROJECT` and the cwd. */
	readonly project?: string;
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
	const { signal } = options;
	const client = await connect(options);

	if (client === undefined) return undefined;
	const abort = () => client.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });

	try {
		signal?.throwIfAborted();

		return await client.request(request);
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
 * Starts a host of `project`, detached, with its output in `host.log`, and connects to it, for 10 s, or until `signal`
 * aborts. A started host that exits with code 0 found the lock held, such as by a host that closes on idle and has not
 * released its lock yet, so it starts a host again, at most once per second. Another exit fails at once.
 */
async function startAndConnect(
	project: string,
	paths: ReturnType<typeof statePaths>,
	signal: AbortSignal | undefined,
): Promise<Socket> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	let host = startHost(project, paths.dir, paths.log);

	for (;;) {
		signal?.throwIfAborted();
		const socket = await tryConnect(paths.socket);

		if (socket !== undefined) return socket;
		const { exited } = host;

		if (exited !== undefined && !("code" in exited && exited.code === 0)) {
			throw new Error(`The harness host exited with ${exitText(exited)}; see ${paths.log}`);
		}

		if (exited !== undefined && Date.now() - host.startedAt >= RESTART_INTERVAL_MS) {
			host = startHost(project, paths.dir, paths.log);
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

/** A host process that `startHost` started. */
type StartedHost = {
	readonly pid: number | undefined;
	readonly startedAt: number;
	/** How the process ended, or undefined while it runs. */
	exited: HostExit | undefined;
};

/** The end of a started host: its exit code or signal, or the error that kept it from running. */
type HostExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null } | { readonly error: string };

function exitText(exited: HostExit): string {
	if ("error" in exited) return `error ${exited.error}`;

	return exited.code === null ? `signal ${exited.signal}` : `code ${exited.code}`;
}

function startHost(project: string, dir: string, log: string): StartedHost {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const output = openSync(log, "a", 0o600);

	try {
		const cli = cliPath();

		const child = spawn(process.execPath, [cli, "--project", project, "host"], {
			cwd: dir,
			detached: true,
			stdio: ["ignore", output, output],
		});

		child.unref();
		const host: StartedHost = { pid: child.pid, startedAt: Date.now(), exited: undefined };

		child.once("exit", (code, signal) => {
			host.exited = { code, signal };
		});
		child.once("error", (error) => {
			host.exited = { error: error.message };
		});

		return host;
	} finally {
		closeSync(output);
	}
}
