/**
 * The host process of a project: its lock, its store, its socket and its idle exit.
 */
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import {
	type Conversation,
	createRegistry,
	type Extension,
	Harness,
	type HarnessInspection,
	type HarnessSettings,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import { ChildContext, PI_TRUST } from "../children/context.ts";
import type { Place } from "../children/library.ts";
import { onLines } from "../protocol/lines.ts";
import { statePaths } from "../protocol/paths.ts";
import {
	errorMessage,
	HOST_CLOSING,
	type Reply,
	type Request,
	RequestLine,
	STORE_LOCK_WAIT_MS,
} from "../protocol/requests.ts";
import { savedTrust } from "../protocol/trust.ts";
import { TURN_DEADLINE_MS } from "../rlm/limits.ts";
import { type DurableScope, projectToolsExtension, type Send, subagentTool, todoTool } from "../tool.ts";
import { setUpAgent } from "./agent.ts";
import { BASH_TIMEOUT_SECONDS, bashTimeoutExtension } from "./bash-timeout.ts";
import { Deadlines } from "./deadlines.ts";
import { type Base, handleRequest } from "./dispatch.ts";
import { loadEntries } from "./entries.ts";
import { ConversationEnvs } from "./envs.ts";
import { gateExtension } from "./gate.ts";
import { type Connection, Push } from "./push.ts";
import { ChildRecords, OldChildRecordsError } from "./records.ts";
import { serveRlm } from "./rlm.ts";
import { library } from "./targets.ts";

/** The host exits after this long with no connection, no live task and no request. */
const IDLE_EXIT_MS = 5 * 60_000;
const IDLE_CHECK_MS = 60_000;

/** How long the close waits for the replies to reach clients that do not read them. */
const REPLY_WRITE_MS = 2000;

const context = BACKGROUND_CONTEXT;

/** The request types that do not count as activity for the idle exit. */
const PASSIVE_REQUESTS: ReadonlySet<Request["type"]> = new Set([
	"hello",
	"list",
	"status",
	"answers",
	"tree",
	"watch-tree",
	"watch-project",
	"classify-todos",
]);

/** The request types whose `list` and `read` actions are passive. */
const LIST_REQUESTS: ReadonlySet<Request["type"]> = new Set(["todo", "person", "thread", "rule", "term", "part"]);

/**
 * Whether `request` does not count as activity for the idle exit. A `list` or a `read` of a todo list or of the store of
 * the project does not, because a widget can poll it, but a change does.
 */
function isPassive(request: Request): boolean {
	return (
		PASSIVE_REQUESTS.has(request.type) ||
		(LIST_REQUESTS.has(request.type) && "action" in request && (request.action === "list" || request.action === "read"))
	);
}

/** A JSON object with a string `type`, which names the request that a line meant. */
const Typed = Type.Object({ type: Type.String() });

export type Host = {
	/** Resolves once the host has closed, by `close()`, the idle exit, or a store failure. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
};

/**
 * Runs the host of `project` in this process: the store and the socket in the project's state directory
 * (`statePaths`), the children's models from `models`, and the project agent in `cwd`. It is undefined when another
 * host holds the lock.
 */
export async function runHost(options: {
	readonly project: string;
	readonly cwd: string;
	readonly models: Models;
	/** For tests: the idle time before the host exits. Default 5 minutes. */
	readonly idleExitMs?: number;
	/** For tests: the time of a turn of an RLM child, after which the host aborts it. Default 5 minutes. */
	readonly rlmDeadlineMs?: number;
	/** For tests: the time after which a bash call that sets no timeout stops. Default 300 seconds. */
	readonly bashTimeoutSeconds?: number;
}): Promise<Host | undefined> {
	const {
		project,
		cwd: projectCwd,
		models,
		idleExitMs = IDLE_EXIT_MS,
		rlmDeadlineMs = TURN_DEADLINE_MS,
		bashTimeoutSeconds = BASH_TIMEOUT_SECONDS,
	} = options;

	const { dir: stateDir, socket: socketPath } = statePaths(project);
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const lock = takeLock(stateDir);

	if (lock === undefined) return undefined;
	rmSync(socketPath, { force: true });

	const registry = createRegistry();
	const agentDir = getAgentDir();

	// The settings and the packages of the project directory, as a Pi session there with the saved trust has them.
	const settings = SettingsManager.create(projectCwd, agentDir, { projectTrusted: savedTrust(projectCwd, PI_TRUST) });

	const warn = (cause: unknown) => process.stderr.write(`warning: ${errorMessage(cause)}\n`);

	// The store is there once the harness is open; entries get `place` before, and use the store in their tasks.
	let harness: Harness | undefined;

	const place: Place = {
		get store() {
			if (harness === undefined) throw new Error("The host is not open yet");

			return harness;
		},
		models,
		get registry() {
			return registry.snapshot();
		},
	};

	const entries = await loadEntries(projectCwd, agentDir, settings, place, library, warn).catch((cause: unknown) => {
		lock.close();
		throw cause;
	});

	const envs = new ConversationEnvs(project, projectCwd);
	// The extension of the tasks of the entries, which is the list of the kinds that `start` can create. The registry
	// refuses a task name that two entries give.
	const startable = durable.defineExtension({ name: "harness-entry-tasks", tasks: entries.tasks });
	let base: Base;
	// The project agent is the root conversation, set up at its first use. A failed set-up runs again at the next use.
	let agentSetUp: Promise<Conversation> | undefined;

	const agent = () =>
		(agentSetUp ??= setUpAgent(base.root, models, settings, project, projectCwd).catch((cause: unknown) => {
			agentSetUp = undefined;
			throw cause;
		}));

	// A child calls the host in this process, not through the socket, so a long `wait` cannot hold up the requests
	// of a connection. Its caller is its conversation ID, which the depth limit, the owner checks and the default list
	// of todos key on. The kernels of `rlm` call it the same way.
	const send: Send = (request, signal) => handleRequest(request, { ...base, signal });
	const scope: DurableScope = { caller: async (api) => String(api.conversationId), send };
	const rlm = serveRlm(entries.events, place, send, warn);

	// Each script runs in a worker thread, in a VM of at most 256 MB, as in Pi.
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });

	const selected = [
		ChildContext,
		subagentTool(durable, { Type }, scope),
		todoTool(durable, { Type }, scope),
		projectToolsExtension(durable, { Type }, scope),
		gateExtension(send),
		bashTimeoutExtension(bashTimeoutSeconds),
		createCodemodeExtension({ sandbox }),
		...entries.extensions,
		rlm.extension,
	];

	try {
		for (const extension of selected) registry.install(extension);
		registry.install(library.extension);
		registry.install(library.answerExtension);
		registry.install(startable);
		harness = await Harness.open(
			// Clients such as the workflows CLI read the store file while the host writes, so wait longer than 5 s for its lock.
			// node:sqlite waits synchronously, so such a wait stops the event loop for as long as it lasts.
			await openNodeSqliteStorage(join(stateDir, "durable.sqlite"), { busyTimeoutMs: STORE_LOCK_WAIT_MS }),
			{
				models,
				registry,
				settings: piSettings(settings, selected),
				env: (target, envContext) => envs.env(target, envContext),
				onReport: (report) => warn(report.error),
			},
			context,
		);

		// A store from before the children library would mix children that it does not know with those it does. The
		// migration of `ChildRecords` refuses it with an `OldChildRecordsError`; any other error is not an old store.
		try {
			await harness.snapshot(ChildRecords, context);
		} catch (error) {
			await harness.close(context);

			if (!(error instanceof OldChildRecordsError)) throw error;
			throw new Error(
				`${join(stateDir, "durable.sqlite")} was written by an older pi-subagent (${error.message}). Stop the host, remove the file and run the command again.`,
			);
		}
	} catch (error) {
		await entries.close();
		lock.close();
		throw error;
	}

	// The host's children outlive every request: each has an anchor task in the root conversation. The anchors are
	// background tasks, so an abort of the root's turn, which is the project agent's, does not reach them.
	const root = await harness.root(context);

	const owner = { kind: "detached", root } as const;
	const push = new Push({ harness, place, owner, root, project, agent, warn });
	const deadlines = new Deadlines({ harness, warn, deadlineMs: rlmDeadlineMs });

	base = {
		harness,
		place,
		owner,
		root,
		project,
		agent,
		startable,
		settings,
		push,
		cwd: projectCwd,
		catchUps: entries.catchUps,
		warn,
	};
	// The resumed tasks call the host, such as the tool of a child, so they resume only once `base` is set.
	harness.resume();

	const connections = new Set<Socket>();
	const aborts = new Set<AbortController>();
	/** The request chains in flight, which the close awaits. */
	const inFlight = new Set<Promise<unknown>>();
	/** The reply writes in flight, which the close awaits for at most `REPLY_WRITE_MS`. */
	const writes = new Set<Promise<boolean>>();
	let lastActivity = Date.now();
	let closing: Promise<void> | undefined;

	const track = (promise: Promise<unknown>) => {
		const settle = () => inFlight.delete(promise);
		inFlight.add(promise);
		promise.then(settle, settle);
	};

	const server = createServer((socket) => {
		connections.add(socket);
		const abort = new AbortController();
		aborts.add(abort);
		let queue = Promise.resolve();
		onLines(socket, (line) => {
			queue = queue.then(async () => {
				let reply: Reply;
				let afterReply: ((written: Promise<boolean>) => void) | undefined;
				const connection: Connection = { socket, afterReply: (run) => (afterReply = run) };

				try {
					// A line that comes while the host closes runs no handler.
					if (closing !== undefined) throw new Error(HOST_CLOSING);
					const request = parseRequest(line);

					if (!isPassive(request)) lastActivity = Date.now();

					reply = {
						ok: true,
						value: await handleRequest(request, { ...base, signal: abort.signal, connection }),
					};
				} catch (error) {
					reply = { ok: false, error: errorMessage(error) };
				}

				// A client that does not read never takes the reply, so the close bounds this wait, and a destroyed socket
				// ends it.
				const written = new Promise<boolean>((resolve) => {
					if (!socket.writable) return resolve(false);
					const onClose = () => resolve(false);
					socket.once("close", onClose);
					socket.write(`${JSON.stringify(reply)}\n`, (error) => {
						socket.off("close", onClose);
						resolve(error == null);
					});
				});

				writes.add(written);
				const settle = () => writes.delete(written);
				written.then(settle, settle);
				afterReply?.(written);
			});
			track(queue);
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			connections.delete(socket);
			aborts.delete(abort);
			abort.abort();
		});
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(socketPath, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	}).catch(async (cause: unknown) => {
		push.close();
		deadlines.close();
		await rlm.close();
		await entries.close();
		await sandbox.close();
		await harness.close(context);
		lock.close();
		throw cause;
	});

	/**
	 * Stops the requests, those of the kernel servers too, with the error `The host is closing`, waits until their
	 * replies are written, and then closes the sockets, the entries, the sandbox and the harness.
	 */
	const close = () => {
		closing ??= (async () => {
			clearInterval(timer);
			push.close();
			deadlines.close();
			server.close();
			const reason = new Error(HOST_CLOSING);

			for (const abort of aborts) abort.abort(reason);

			try {
				// The requests of the kernels stop the same way, before the entries stop the kernels.
				await rlm.close();

				// Each handler reads its signal or ends once the push closes, so this needs no timeout.
				while (inFlight.size > 0) await Promise.allSettled(inFlight);
				await waitAtMost(Promise.allSettled(writes), REPLY_WRITE_MS);

				for (const socket of connections) socket.destroy();

				// Entries close first: an entry may still need the open harness. The sandbox closes before the harness, so a
				// script that runs gets no outcome and continues after a restart.
				await entries.close();
				await sandbox.close();
				await harness.close(context);

				await envs.cleanup(context);
			} finally {
				rmSync(socketPath, { force: true });
				lock.close();
			}
		})();

		return closing;
	};

	const timer = setInterval(
		() => {
			// A connection with an open `answers` request alone does not keep the host running.
			const busy = () => [...connections].some((socket) => !push.listens(socket));

			if (busy() || Date.now() - lastActivity < idleExitMs) return;
			harness
				.inspect(context)
				.then(({ tasks }) => (liveTasks(tasks) === 0 && !busy() ? close() : undefined))
				.catch(warn);
		},
		Math.min(IDLE_CHECK_MS, idleExitMs),
	);

	timer.unref();
	// A store failure closes the harness; the host then closes too.
	const closed = harness.closed.then(() => close());

	return { closed, close };
}

/**
 * The request of a line from a client, checked against the protocol. A line that fails names its request type and the
 * first field that is wrong.
 */
function parseRequest(line: string): Request {
	const request: unknown = JSON.parse(line);

	if (Value.Check(RequestLine, request)) return request;

	if (!Value.Check(Typed, request)) throw new Error("Invalid request");

	// The branch of the request's type with the fewest errors names the field; on a tie, the first one wins.
	const [best] = RequestLine.anyOf
		.map((schema) => [...Value.Errors(schema, request)])
		.filter((errors) => errors.every((error) => error.instancePath !== "/type"))
		.sort((a, b) => a.length - b.length);

	if (best === undefined) throw new Error(`Unknown request: ${request.type}`);

	// SAFETY: Value.Check refused every branch, so each branch, and the best one, has at least one error.
	const [error] = best as [TLocalizedValidationError, ...TLocalizedValidationError[]];

	throw new Error(`Invalid ${request.type} request: ${requestError(error)}`);
}

/** The field of a request error, and what is wrong with it. */
function requestError(error: TLocalizedValidationError): string {
	if (error.keyword === "required") return `${error.params.requiredProperties[0]} is required`;
	const field = error.instancePath.split("/")[1];

	return error.keyword === "not" ? `${field} is not allowed` : `${field} is not valid`;
}

/** Waits for `promise`, or for `ms` at most. */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;

	await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
	clearTimeout(timer);
}

/**
 * The lock of the host, a write transaction on `lock.sqlite`, held until `close()`. The system drops it when the
 * process ends. It is undefined when another process holds it. `IMMEDIATE`, not `EXCLUSIVE`: two hosts that start at
 * the same time can both fail `EXCLUSIVE`, each holding a lock the other one needs, and then no host runs.
 */
function takeLock(directory: string): DatabaseSync | undefined {
	const database = new DatabaseSync(join(directory, "lock.sqlite"), { timeout: 0 });

	try {
		database.exec("BEGIN IMMEDIATE");

		return database;
	} catch {
		database.close();

		return undefined;
	}
}

/** Pi's run settings from `settings`, read at every use, with `extensions` as the default selection. */
function piSettings(settings: SettingsManager, extensions: readonly Extension[]): HarnessSettings {
	return {
		extensions,
		get stream() {
			const provider = settings.getProviderRetrySettings();
			const idle = settings.getHttpIdleTimeoutMs();

			const stream = {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
			};

			return provider.maxRetries === undefined ? stream : { ...stream, maxRetries: provider.maxRetries };
		},
		get retry() {
			return settings.getRetrySettings();
		},
		get compaction() {
			return settings.getCompactionSettings();
		},
	};
}

/**
 * The tasks that keep the host running. A blocked task, such as one of an entry that is no longer installed, never runs
 * again in this host, and neither does a task that waits only on such tasks.
 */
function liveTasks(tasks: HarnessInspection["tasks"]): number {
	const dead = new Set<number>(tasks.filter((task) => task.state.kind === "blocked").map((task) => task.record.id));

	for (let grown = true; grown;) {
		grown = false;

		for (const task of tasks) {
			const { state } = task;

			if (dead.has(task.record.id) || state.kind !== "waiting" || !state.on.every((id) => dead.has(id))) continue;
			dead.add(task.record.id);
			grown = true;
		}
	}

	return tasks.length - dead.size;
}
