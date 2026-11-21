/**
 * The host process of a project: its lock, its store, its socket and its idle exit.
 */
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	type Extension,
	Harness,
	type HarnessInspection,
	type HarnessSettings,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type TSchema, Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Pointer, Value } from "typebox/value";
import { childContext, PI_TRUST, type ResourcesReport } from "../children/context.ts";
import type { Place } from "../children/library.ts";
import { projectToolsExtension } from "../project-tool.ts";
import { onLines } from "../protocol/lines.ts";
import { statePaths } from "../protocol/paths.ts";
import { memoryDir } from "../protocol/projects.ts";
import {
	errorMessage,
	HOST_CLOSING,
	type Reply,
	type Request,
	RequestLine,
	STORE_LOCK_WAIT_MS,
} from "../protocol/requests.ts";
import { savedTrust } from "../protocol/trust.ts";
import { type DurableScope, type Send, subagentTool, todoTool } from "../tool.ts";
import { setUpAgent } from "./agent.ts";
import { AskEventDispatcher } from "./ask-events.ts";
import { readOpenAsks } from "./asks.ts";
import { BASH_TIMEOUT_SECONDS, bashTimeoutExtension } from "./bash-timeout.ts";
import { serveBridge } from "./bridge.ts";
import { askClassifier, classifierModel } from "./classify.ts";
import { Degraded } from "./degraded.ts";
import { queueDelivery } from "./deliveries.ts";
import { type Base, handleLine, handleRequest, type Line } from "./dispatch.ts";
import { type EntryHandles, EntryLine, type EntryRequest, loadEntries } from "./entries.ts";
import { ConversationEnvs } from "./envs.ts";
import { gateExtension } from "./gate.ts";
import { ItemIndex } from "./item-index.ts";
import { migrateTodos } from "./item-migration.ts";
import { type AwakeSystem, keepAwake, NODE_AWAKE_SYSTEM } from "./keep-awake.ts";
import { takeLock } from "./lock.ts";
import { HostMcp } from "./mcp.ts";
import { Compressor, type HostMemory, memoryExtension } from "./memory.ts";
import { parleyReaction } from "./parleys.ts";
import { type Connection, Push } from "./push.ts";
import { ChildRecords, OldChildRecordsError } from "./records.ts";
import { RulesSection } from "./rules-section.ts";
import { Serving } from "./serving.ts";
import { SESSION_END_MS, Sessions } from "./sessions.ts";
import { storeFilePasses } from "./store-file.ts";
import { library } from "./targets.ts";

/** The host exits after this long with no connection, no live task, no compression of the memory and no request. */
const IDLE_EXIT_MS = 5 * 60_000;
const IDLE_CHECK_MS = 60_000;

/** How long the close waits for the replies to reach clients that do not read them. */
const REPLY_WRITE_MS = 2000;

const context = BACKGROUND_CONTEXT;

const passive = () => true;
const active = () => false;

/** Whether a request with an action is a `list` or a `read`, which a widget can poll, and not a change. */
const listOrRead = (request: { readonly action: string }) => request.action === "list" || request.action === "read";

/**
 * Whether a request of each core type does not count as activity for the idle exit. Its keys are the request types that
 * the host owns.
 */
const CORE_PASSIVE = {
	hello: passive,
	list: passive,
	status: passive,
	answers: passive,
	tree: passive,
	"watch-tree": passive,
	"watch-project": passive,
	"classify-todos": passive,
	todo: listOrRead,
	person: listOrRead,
	thread: listOrRead,
	rule: listOrRead,
	ask: listOrRead,
	parley: listOrRead,
	item: listOrRead,
	spawn: active,
	send: active,
	input: active,
	note: active,
	wait: active,
	abort: active,
	query: active,
	configure: active,
	watch: active,
	start: active,
	task: active,
	"wait-task": active,
	"abort-task": active,
	message: active,
	digest: active,
	memory: active,
	gate: active,
	held: active,
	whoami: active,
	rename: active,
	stop: active,
} satisfies { readonly [T in Request["type"]]: (request: Extract<Request, { type: T }>) => boolean };

/** The request types that the host owns. */
const CORE_TYPES: ReadonlySet<string> = new Set(Object.keys(CORE_PASSIVE));

/**
 * Whether `line` does not count as activity for the idle exit: by the rule of its core type, or by the `passive` rule
 * of the entry that serves it.
 */
function isPassive(line: Line): boolean {
	if (line.kind === "entry") return line.served.passive(line.request);
	// SAFETY: the rule of the type of the request takes that request.
	const rule = CORE_PASSIVE[line.request.type] as (request: Request) => boolean;

	return rule(line.request);
}

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
	/** For tests: the time after which a bash call that sets no timeout stops. Default 300 seconds. */
	readonly bashTimeoutSeconds?: number;
	/** For tests: the system of the hold that keeps the Mac awake. Default the system of this process. */
	readonly keepAwake?: AwakeSystem;
	/** For tests: how long a Pi session may have no open `answers` request before it ends. Default 30 seconds. */
	readonly sessionEndMs?: number;
}): Promise<Host | undefined> {
	const {
		project,
		cwd: projectCwd,
		models,
		idleExitMs = IDLE_EXIT_MS,
		bashTimeoutSeconds = BASH_TIMEOUT_SECONDS,
		keepAwake: awakeSystem = NODE_AWAKE_SYSTEM,
		sessionEndMs = SESSION_END_MS,
	} = options;

	const { dir: stateDir, socket: socketPath, store: storePath } = statePaths(project);
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const lock = takeLock(stateDir);

	if (lock === undefined) return undefined;
	rmSync(socketPath, { force: true });

	const registry = createRegistry();
	const agentDir = getAgentDir();

	// The settings and the packages of the project directory, as a Pi session there with the saved trust has them.
	const projectTrusted = savedTrust(projectCwd, PI_TRUST);
	const settings = SettingsManager.create(projectCwd, agentDir, { projectTrusted });

	const warn = (cause: unknown) => process.stderr.write(`warning: ${errorMessage(cause)}\n`);
	// The degraded states of the host, which `watch-project` gives; each source also writes its warning to `host.log`.
	const degraded = new Degraded(warn);

	// The store is there once the harness is open; entries get `place` before, and use the store in their tasks.
	let harness: Harness | undefined;
	// The storage of the harness, whose scan `store.json` uses for the lists of the callers.
	let storage: Storage | undefined;
	// The root conversation, which entry deliveries need to know, once the harness is open.
	let rootId: ConversationId | undefined;

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

	const handles: EntryHandles = {
		stateDir,
		openAsks: () => readOpenAsks(place.store, context),
		degraded,
		warn,
		classifier: {
			model: (key) => classifierModel(settings, models, key, degraded),
			ask: (model, classifierContext, signal) => askClassifier(models, model, classifierContext, signal),
		},
		deliver: async (delivery) => {
			if (harness === undefined || rootId === undefined) throw new Error("The host is not open yet");
			await queueDelivery(harness, rootId, delivery, context);
		},
	};

	const entries = await loadEntries(projectCwd, agentDir, settings, place, library, CORE_TYPES, handles).catch(
		(cause: unknown) => {
			lock.close();
			throw cause;
		},
	);

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
	// of todos key on.
	const send: Send = (request, signal) => handleRequest(request, { ...base, signal });
	const scope: DurableScope = { caller: async (api) => String(api.conversationId), send };
	const bridge = serveBridge(entries.events, warn);

	// Each script runs in a worker thread, in a VM of at most 256 MB, as in Pi.
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });

	const resources: ResourcesReport = {
		loaded: (cwd) => degraded.end("resources-failed", cwd),
		failed: (cwd, line) => degraded.start("resources-failed", cwd, line),
	};

	// The compressions of the memory of the project agent, which run in the background.
	const compressor = new Compressor({ settings, models, warn });
	const memory: HostMemory = { compressor, dir: () => memoryDir(project, projectCwd) };
	// The MCP servers of the host, which connect once the harness is open.
	const mcp = new HostMcp({ registry, sandbox, agentDir, cwd: projectCwd, trusted: projectTrusted, models, warn });

	const selected = [
		childContext(resources),
		RulesSection,
		memoryExtension(memory, scope),
		subagentTool(durable, { Type }, scope),
		todoTool(durable, { Type }, scope),
		projectToolsExtension(durable, { Type }, scope),
		gateExtension(send),
		bashTimeoutExtension(bashTimeoutSeconds),
		...mcp.extensions,
		...entries.extensions,
	];

	try {
		for (const extension of selected) registry.install(extension);
		registry.install(library.extension);
		registry.install(library.answerExtension);
		registry.install(startable);
		// Clients such as the workflows CLI read the store file while the host writes, so wait longer than 5 s for its lock.
		// node:sqlite waits synchronously, so such a wait stops the event loop for as long as it lasts.
		storage = await openNodeSqliteStorage(join(stateDir, "durable.sqlite"), { busyTimeoutMs: STORE_LOCK_WAIT_MS });
		harness = await Harness.open(
			storage,
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

	mcp.start();

	// The host's children outlive every request: each has an anchor task in the root conversation. The anchors are
	// background tasks, so an abort of the root's turn, which is the project agent's, does not reach them.
	const root = await harness.root(context);
	rootId = root.id;

	const owner = { kind: "detached", root } as const;
	// The first start moves the todos of the project to items, before any reader of the items or the records.
	await migrateTodos(harness, root.id);
	// The index of the ends of the items observes the commits first, so the observers and the passes after it read it
	// current with each commit.
	const items = await ItemIndex.open(harness, storage);

	const push = new Push({
		harness,
		place,
		owner,
		root,
		project,
		agent,
		items,
		warn,
		degraded,
		storage,
		inputHooks: entries.inputHooks,
	});

	const sessions = await Sessions.open({ harness, place, owner, warn }, sessionEndMs);
	const serving = new Serving({ harness, place, owner, items, warn });

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
		sessions,
		storage,
		items,
		cwd: projectCwd,
		catchUps: entries.catchUps,
		inputHooks: entries.inputHooks,
		entryVersions: entries.versions,
		warn,
		degraded,
		memory,
	};
	// The resumed tasks call the host, such as the tool of a child, so they resume only once `base` is set.
	harness.resume();

	const reaction = parleyReaction({ harness, items, warn });

	const askEvents = new AskEventDispatcher(
		harness,
		entries.answeredAsk === undefined ? [reaction] : [reaction, entries.answeredAsk],
		warn,
	);

	const storeFile = storeFilePasses({ harness, storage, root, path: storePath, warn });

	const awake = keepAwake({ active: () => harness.wake().active, degraded, system: awakeSystem });

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
					const parsed = parseLine(line, entries.requests);

					if (!isPassive(parsed)) lastActivity = Date.now();

					reply = { ok: true, value: await handleLine(parsed, { ...base, signal: abort.signal, connection }) };
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
		await compressor.close();
		await push.close();
		await sessions.close();
		await serving.close();
		// The reaction of the parleys reads the index of the items.
		await askEvents.close();
		items.close();
		await storeFile.close();
		awake.close();
		await bridge.close();
		await entries.close();
		await sandbox.close();
		await harness.close(context);
		await mcp.close();
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
			const compressorClosed = compressor.close();
			const pushClosed = push.close();
			// The socket closes that follow are not session ends.
			const sessionsClosed = sessions.close();
			const servingClosed = serving.close();
			const storeFileClosed = storeFile.close();
			// The handler of the answered asks gets the abort, and its event waits for the next start.
			const askEventsClosed = askEvents.close();
			awake.close();
			server.close();
			const reason = new Error(HOST_CLOSING);

			for (const abort of aborts) abort.abort(reason);

			try {
				// The requests of the kernels stop the same way, before the entries stop the kernels.
				await bridge.close();

				// Each handler reads its signal or ends once the push closes, so this needs no timeout.
				while (inFlight.size > 0) await Promise.allSettled(inFlight);
				await waitAtMost(Promise.allSettled(writes), REPLY_WRITE_MS);

				for (const socket of connections) socket.destroy();

				// Entries close first: an entry may still need the open harness. The sandbox closes before the harness, so a
				// script that runs gets no outcome and continues after a restart.
				await askEventsClosed;
				await entries.close();
				await sandbox.close();
				await pushClosed;
				await sessionsClosed;
				await servingClosed;
				items.close();
				await storeFileClosed;
				await compressorClosed;
				await harness.close(context);
				await mcp.close();

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
			// A connection with an open `answers` request alone does not keep the host running; a compression of the
			// memory does.
			const busy = () => [...connections].some((socket) => !push.listens(socket)) || compressor.running > 0;

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
 * The request of a line from a client, checked against the protocol, or against the schema of the entry of `served`
 * that serves its type. A line that fails names its request type, and the path and the rule of the first field that is
 * wrong. A line of a type that neither the host nor an entry serves fails with
 * `no loaded entry serves request type "<type>"`.
 */
function parseLine(line: string, served: ReadonlyMap<string, EntryRequest>): Line {
	const request: unknown = JSON.parse(line);

	if (Value.Check(RequestLine, request)) return { kind: "core", request };

	if (!Value.Check(EntryLine, request)) throw new Error("Invalid request");
	const entry = served.get(request.type);

	if (entry !== undefined) {
		const [error] = Value.Errors(entry.schema, request);

		if (error === undefined) return { kind: "entry", request, served: entry };

		throw new Error(`Invalid ${request.type} request: ${requestError(entry.schema, error)}`);
	}

	if (!CORE_TYPES.has(request.type)) throw new Error(`no loaded entry serves request type "${request.type}"`);

	// The branch of the request's type, and of its action when a branch has it, with the fewest errors names the field;
	// on a tie, the first one wins.
	const ofType = RequestLine.anyOf
		.map((schema) => ({ schema, errors: [...Value.Errors(schema, request)] }))
		.filter(({ errors }) => errors.every((error) => error.instancePath !== "/type"));

	const ofAction = ofType.filter(({ errors }) => errors.every((error) => error.instancePath !== "/action"));
	const [best] = (ofAction.length > 0 ? ofAction : ofType).sort((a, b) => a.errors.length - b.errors.length);

	// The type is a core type, so the branches of its type are there.
	if (best === undefined) throw new Error(`Invalid ${request.type} request`);

	// SAFETY: Value.Check refused every branch, so each branch, and the best one, has at least one error.
	const [error] = best.errors as [TLocalizedValidationError, ...TLocalizedValidationError[]];

	throw new Error(`Invalid ${request.type} request: ${requestError(best.schema, error)}`);
}

/**
 * The `<path>: <rule>` of a request error from the `schema` of its request branch. The path has no leading slash. The
 * rule is `required` or `not allowed` for these keywords, else the description of the failing schema, else the
 * message of typebox.
 */
function requestError(schema: TSchema, error: TLocalizedValidationError): string {
	const path = error.instancePath.slice(1);

	if (error.keyword === "required") {
		const property = error.params.requiredProperties[0];

		return `${path === "" ? property : `${path}/${property}`}: required`;
	}

	if (error.keyword === "not") return `${path}: not allowed`;

	const failing: unknown = Pointer.Get(schema, error.schemaPath.slice(1));
	const description = Value.Check(Described, failing) ? failing.description : error.message;

	return `${path}: ${description}`;
}

/** A schema with a description. */
const Described = Type.Object({ description: Type.String() });

/** Waits for `promise`, or for `ms` at most. */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;

	await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
	clearTimeout(timer);
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
