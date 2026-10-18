import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { Readable } from "node:stream";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { checkProject, MAIN_PROJECT, resolveProject } from "./projects.ts";
import {
	cliPath,
	onLines,
	PROTOCOL_VERSION,
	type Replies,
	type Request,
	statePaths,
	type WatchLine,
} from "./protocol.ts";

const START_TIMEOUT_MS = 10_000;

/** A line from the host: a reply, or an event of the watch. The value of a reply and the event are not checked here. */
const HostLine = Type.Union([
	Type.Object({ ok: Type.Literal(true), value: Type.Optional(Type.Unknown()) }),
	Type.Object({ ok: Type.Literal(false), error: Type.String() }),
	Type.Object({ event: Type.Unknown() }),
]);

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
			const parsed: unknown = JSON.parse(line);

			if (!Value.Check(HostLine, parsed)) {
				this.#pending.shift()?.reject(new Error(`The harness host sent an invalid reply: ${line}`));

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
	 * Sends the `watch` request of `handle`. Its `lines` are the events of the watch, and end when the connection closes.
	 * Other requests can follow on this client. Call it once.
	 */
	async watch(handle: string): Promise<Replies["watch"] & { lines: AsyncIterable<WatchLine> }> {
		const lines = new Readable({ objectMode: true, read() {} });
		this.#lines = lines;
		const reply = await this.request({ type: "watch", handle });

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
 * after its `hello`. When no host listens and `start` is true, it starts one, detached, with its output in `host.log`,
 * and tries to connect for 10 s, or until `signal` aborts. When no host listens and `start` is false, it is undefined.
 */
export async function connect(options: ConnectOptions): Promise<Client | undefined> {
	const project =
		options.project === undefined ? resolveProject(process.env, process.cwd()) : checkProject(options.project);

	const paths = statePaths(project);
	let socket = await tryConnect(paths.socket);

	if (socket === undefined) {
		if (!options.start) return undefined;
		startHost(project, paths.dir, paths.log);
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

		// A stopped host restarts from the installed code, which is the newer side here, so only the client can catch up.
		if (hello.version > PROTOCOL_VERSION) {
			throw new Error(
				`This client uses harness protocol ${PROTOCOL_VERSION} and the host (pid ${hello.pid}) uses ${hello.version}. Reload Pi with /reload, or use the harness CLI of the host's install`,
			);
		}

		if (hello.version !== PROTOCOL_VERSION) {
			throw new Error(
				`The harness host (pid ${hello.pid}) uses protocol ${hello.version}, not ${PROTOCOL_VERSION}. The host is older: stop it with kill ${hello.pid} and run the command again`,
			);
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

function startHost(project: string, dir: string, log: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const output = openSync(log, "a", 0o600);

	try {
		const cli = cliPath();
		spawn(process.execPath, [cli, "--project", project, "host"], {
			cwd: dir,
			detached: true,
			stdio: ["ignore", output, output],
		}).unref();
	} finally {
		closeSync(output);
	}
}
