import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	onLines,
	PROTOCOL_VERSION,
	type Replies,
	type Reply,
	type Request,
	statePaths,
	type WatchLine,
} from "./protocol.ts";

const START_TIMEOUT_MS = 10_000;

/** A connection to the host. Requests are answered in order, one reply line for each request line. */
export class Client {
	readonly #socket: Socket;
	readonly #pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
	#ended = false;
	/** Gets the lines that no request waits for. Only `watch` sets it; otherwise such a line is dropped. */
	#stream: { line: (line: string) => void; end: () => void } | undefined;
	/** The process ID of the host, from its `hello` reply. */
	pid = 0;

	constructor(socket: Socket) {
		this.#socket = socket;
		onLines(socket, (line) => {
			const waiter = this.#pending.shift();
			if (waiter === undefined) {
				this.#stream?.line(line);
				return;
			}
			const reply = JSON.parse(line) as Reply;
			if (reply.ok) waiter.resolve(reply.value);
			else waiter.reject(new Error(reply.error));
		});
		socket.on("error", () => this.#end());
		socket.on("close", () => this.#end());
	}

	request<T extends Request["type"]>(request: Extract<Request, { type: T }>): Promise<Replies[T]> {
		if (this.#ended) return Promise.reject(new Error("The harness host closed the connection"));
		return new Promise((resolve, reject) => {
			this.#pending.push({ resolve: resolve as (value: unknown) => void, reject });
			this.#socket.write(`${JSON.stringify(request)}\n`);
		});
	}

	/**
	 * Sends the `watch` request of `handle`. After it, the connection carries only the watch: do not send other
	 * requests, the host closes the connection. The lines that come before `listen` wait for it.
	 */
	async watch(handle: string): Promise<Watch> {
		const buffer: WatchLine[] = [];
		let onLine: (line: WatchLine) => void = (line) => buffer.push(line);
		let onEnd: (() => void) | undefined;
		this.#stream = { line: (line) => onLine(JSON.parse(line) as WatchLine), end: () => onEnd?.() };
		const reply = await this.request({ type: "watch", handle });
		return {
			...reply,
			listen: (lineListener, endListener) => {
				for (const line of buffer.splice(0)) lineListener(line);
				onLine = lineListener;
				if (this.#ended) endListener();
				else onEnd = endListener;
			},
			close: () => this.close(),
		};
	}

	close(): void {
		this.#socket.end();
	}

	/** Rejects the pending requests with `reason` and closes the connection. The host then stops them. */
	abort(reason: unknown): void {
		this.#end(reason);
		this.#socket.destroy();
	}

	#end(reason: unknown = new Error("The harness host closed the connection")): void {
		if (!this.#ended) this.#stream?.end();
		this.#ended = true;
		for (const waiter of this.#pending.splice(0)) waiter.reject(reason);
	}
}

/** A watch of a child on a connection of its own: the reply of the `watch` request, and the lines after it. */
export type Watch = Replies["watch"] & {
	/**
	 * Calls `onLine` with each line after the reply, the lines that came before this call first, and `onEnd` once when
	 * the connection closes. Call it once.
	 */
	listen(onLine: (line: WatchLine) => void, onEnd: () => void): void;
	close(): void;
};

/**
 * A connection to the host after its `hello`. When no host listens and `start` is true, it starts one, detached, with its
 * output in `host.log`, and tries to connect for 10 s, or until `signal` aborts. When no host listens and `start` is
 * false, it is undefined.
 */
export async function connect(options: ConnectOptions): Promise<Client | undefined> {
	const paths = statePaths();
	let socket = await tryConnect(paths.socket);
	if (socket === undefined) {
		if (!options.start) return undefined;
		startHost(paths.dir, paths.log);
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (socket === undefined) {
			options.signal?.throwIfAborted();
			if (Date.now() > deadline) throw new Error(`Could not start the harness host; see ${paths.log}`);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			socket = await tryConnect(paths.socket);
		}
	}
	const client = new Client(socket);
	try {
		const hello = await client.request({ type: "hello", version: PROTOCOL_VERSION });
		if (hello.version !== PROTOCOL_VERSION) {
			throw new Error(
				`The harness host (pid ${hello.pid}) uses protocol ${hello.version}, not ${PROTOCOL_VERSION}; stop it and try again`,
			);
		}
		client.pid = hello.pid;
		return client;
	} catch (error) {
		client.close();
		throw error;
	}
}

/** Watches the child `handle` on a new connection. It starts the host as `connect` does. */
export async function watch(handle: string): Promise<Watch> {
	const client = await connect({ start: true });
	if (client === undefined) throw new Error("Could not connect to the harness host");
	try {
		return await client.watch(handle);
	} catch (error) {
		client.close();
		throw error;
	}
}

type ConnectOptions = { readonly start: boolean; readonly signal?: AbortSignal | undefined };

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

function startHost(dir: string, log: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const output = openSync(log, "a", 0o600);
	try {
		const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
		spawn(process.execPath, [cli, "host"], { cwd: dir, detached: true, stdio: ["ignore", output, output] }).unref();
	} finally {
		closeSync(output);
	}
}
