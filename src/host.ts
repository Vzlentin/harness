import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import * as ai from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import {
	type Conversation,
	createRegistry,
	type DocumentWatch,
	type Extension,
	Harness,
	type HarnessInspection,
	type HarnessSettings,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { catchUp } from "./catchup.ts";
import { type Place, resolveModel, type Spec } from "./children.ts";
import { ChildContext, PI_TRUST } from "./context.ts";
import { ConversationEnvs } from "./conversation-envs.ts";
import { loadEntries } from "./load-entries.ts";
import {
	AGENT_HANDLE,
	type ChildInfo,
	errorMessage,
	onLines,
	PROTOCOL_VERSION,
	type Replies,
	type Reply,
	type Request,
	RequestLine,
	STORE_LOCK_WAIT_MS,
	type Target,
	versionMismatch,
	type WatchLine,
} from "./protocol.ts";
import { type Connection, Push } from "./push.ts";
import {
	addSent,
	type ChildRecord,
	Children,
	type ChildrenState,
	childInfo,
	childOf,
	childRecord,
	childTarget,
	type Found,
	library,
	markRead,
	ownRecord,
	recordOf,
	removeSent,
	type TargetHost,
	target,
	turnRunning,
} from "./targets.ts";
import { abortTask, startableTasks, startTask, type TaskHost, taskInfo, waitTask } from "./tasks.ts";
import { subagentTool } from "./tool.ts";
import { savedTrust } from "./trust.ts";
import { type UnreadAnswers, unreadAnswers } from "./unread.ts";
import { type ViewChange, viewChange } from "./view-change.ts";

/** The host exits after this long with no connection, no live task and no request. */
const IDLE_EXIT_MS = 5 * 60_000;
const IDLE_CHECK_MS = 60_000;
const context = BACKGROUND_CONTEXT;

/** The requests that do not count as activity for the idle exit. */
const PASSIVE_REQUESTS: ReadonlySet<Request["type"]> = new Set(["hello", "list", "status", "answers"]);

/** The depth limit of the subagent tree when Pi's global settings have no valid `agentDepthLimit`. */
const DEPTH_LIMIT = 4;
const DepthSetting = Type.Object({ agentDepthLimit: Type.Integer({ minimum: 1 }) });

/** The answer of a `wait` for a turn whose answer a push already gave. */
const NO_NEW_ANSWERS = "No new answers: the last answer came as a message.";

export type Host = {
	/** Resolves once the host has closed, by `close()`, the idle exit, or a store failure. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
};

/**
 * Runs the host of `project` in this process: the store in `stateDir`, the children's models from `models`, the
 * project agent in `cwd`, and the socket. It is undefined when another host holds the lock.
 */
export async function runHost(options: {
	readonly stateDir: string;
	readonly project: string;
	readonly cwd: string;
	readonly models: Models;
	/** For tests: the idle time before the host exits. Default 5 minutes. */
	readonly idleExitMs?: number;
}): Promise<Host | undefined> {
	const { stateDir, project, cwd: projectCwd, models, idleExitMs = IDLE_EXIT_MS } = options;
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const lock = takeLock(stateDir);

	if (lock === undefined) return undefined;
	const socketPath = join(stateDir, "host.sock");
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
	const startable = startableTasks(entries.tasks);
	let base: Base;
	// The project agent is the root conversation, set up at its first use. A failed set-up runs again at the next use.
	let agentSetUp: Promise<Conversation> | undefined;

	const agent = () =>
		(agentSetUp ??= setUpAgent(base.root, models, settings, project, projectCwd).catch((cause: unknown) => {
			agentSetUp = undefined;
			throw cause;
		}));

	// A child calls the host in this process, not through the socket, so a long `wait` cannot hold up the requests
	// of a connection. Its caller is its conversation ID, which the depth limit and the owner checks key on.
	const tool = subagentTool(durable, ai, {
		caller: async (api) => String(api.conversationId),
		send: (request, signal) => handleRequest(request, { ...base, signal }),
	});

	// Each script runs in a worker thread, in a VM of at most 256 MB, as in Pi.
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
	const selected = [ChildContext, tool, createCodemodeExtension({ sandbox }), ...entries.extensions];

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
				onReport: warn,
			},
			context,
		);

		// A store from before the children library would mix children that it does not know with those it does.
		// pi-durable's checkRecordVersion (documents.ts) refuses a stored version below the definition's with a plain Error,
		// "Document <id> (<kind>) requires migration from version <n>"; any other error is not an old store.
		try {
			await harness.snapshot(Children, context);
		} catch (error) {
			await harness.close(context);
			const message = errorMessage(error);

			if (!message.includes("(subagent.children) requires migration from version")) throw error;
			throw new Error(
				`${join(stateDir, "durable.sqlite")} was written by an older pi-subagent (${message}). Stop the host, remove the file and run the command again.`,
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

	base = { harness, place, owner, root, project, agent, startable, settings, push, cwd: projectCwd, warn };
	// The resumed tasks call the host, such as the tool of a child, so they resume only once `base` is set.
	harness.resume();

	const connections = new Set<Socket>();
	const aborts = new Set<AbortController>();
	let lastActivity = Date.now();

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
					const request = parseRequest(line);

					if (!PASSIVE_REQUESTS.has(request.type)) lastActivity = Date.now();

					reply = {
						ok: true,
						value: await handleRequest(request, { ...base, signal: abort.signal, connection }),
					};
				} catch (error) {
					reply = { ok: false, error: errorMessage(error) };
				}

				const written = new Promise<boolean>((resolve) => {
					if (socket.writable) socket.write(`${JSON.stringify(reply)}\n`, (error) => resolve(error == null));
					else resolve(false);
				});

				afterReply?.(written);
			});
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
		await entries.close();
		await sandbox.close();
		await harness.close(context);
		lock.close();
		throw cause;
	});

	let closing: Promise<void> | undefined;

	const close = () => {
		closing ??= (async () => {
			clearInterval(timer);
			push.close();
			server.close();

			for (const socket of connections) socket.destroy();

			for (const abort of aborts) abort.abort();

			try {
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

/** What every request of the host uses. */
type Base = Omit<TaskHost, "signal"> &
	TargetHost & {
		/** The root conversation, which owns the host's children and is the project agent. */
		readonly root: Conversation;
		/** Pi's settings, for the depth limit of the subagent tree. */
		readonly settings: SettingsManager;
		readonly push: Push;
		/** The project directory. */
		readonly cwd: string;
		readonly warn: (cause: unknown) => void;
	};

type Handler = Base &
	TaskHost & {
		/** The socket of the request, and its hook after the reply. The in-process tool has none. */
		readonly connection?: Connection;
	};

function handleRequest<T extends Request["type"]>(
	request: Extract<Request, { type: T }>,
	handler: Handler,
): Promise<Replies[T]>;
function handleRequest(request: RequestLine, handler: Handler): Promise<Replies[RequestLine["type"]]>;
async function handleRequest(request: RequestLine, handler: Handler): Promise<Replies[RequestLine["type"]]> {
	switch (request.type) {
		case "hello":
			if (request.version !== PROTOCOL_VERSION) {
				throw new Error(versionMismatch(request.version, PROTOCOL_VERSION, process.pid));
			}

			return { version: PROTOCOL_VERSION, pid: process.pid };
		case "spawn":
			return spawnChild(request, handler);
		case "send": {
			const record = await ownRecord(handler.harness, request.handle, request.caller);

			// A sweep leaves the child while its request is in `sent` and not yet admitted.
			return handler.push.whileActive(request.handle, async () => {
				// Mark the request first: a wait that sees it as the last request must find it in `sent`.
				const added = await addSent(handler.harness, request.handle, request.requestId, request);

				try {
					return await sendTo(request, await childTarget(handler, request.handle, record), handler.harness);
				} catch (error) {
					if (added) await removeSent(handler.harness, request.handle, request.requestId);
					throw error;
				}
			});
		}

		case "input": {
			const found = await target(handler, request);

			if (request.handle === AGENT_HANDLE) await catchUp(handler, found.write, request.requestId);

			// A conversation takes input only while it works, so its input is always a steer.
			return sendTo(
				request.conversation === undefined ? request : { ...request, followUp: false },
				found,
				handler.harness,
			);
		}

		case "note":
			return noteTo(request, handler);
		case "wait":
			return handler.push.whileActive(request.handle, () => waitChild(request, handler));
		case "answers":
			if (handler.connection === undefined) throw new Error("answers needs a connection");

			return handler.push.listen(request.caller, handler.connection, handler.signal);
		case "status":
			return childInfo(handler, request.handle);
		case "abort":
			return abortChild(request, handler);
		case "configure":
			return configureChild(request, handler);
		case "watch":
			if (handler.connection === undefined) throw new Error("A watch needs a connection");

			return serveWatch(handler, request, handler.connection);
		case "start":
			// A child that a task opens without a model takes the project agent's, so the agent is set up first. Without
			// a model for the agent, the task still starts: its children may name their own.
			await handler.agent().catch(() => undefined);

			return startTask(handler, request);
		case "task":
			return taskInfo(handler.harness, request.key);
		case "wait-task":
			return waitTask(handler, request.key);
		case "abort-task":
			return abortTask(handler.harness, request.key);
		case "list": {
			const state = await handler.harness.snapshot(Children, context);

			const own = Object.entries(state?.children ?? {})
				.filter(([, record]) => record.caller === request.caller)
				.sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));

			// A child that the library closed outside `stop`, such as a subagent of a workflow session when its run ends,
			// keeps its record until a `stop`, and is not listed.
			const infos = await Promise.all(
				own.map(async ([handle, record]) =>
					(await (await childOf(handler, record)).state(context)) === "closed"
						? undefined
						: childInfo(handler, handle, record),
				),
			);

			return infos.filter((info) => info !== undefined);
		}

		case "rename": {
			await ownRecord(handler.harness, request.handle, request.caller);
			await handler.harness.commit(async (tx) => {
				const record = (await tx.doc(Children)).children[request.handle];

				if (record !== undefined) record.name = request.name;
			}, context);

			return childInfo(handler, request.handle);
		}

		case "stop": {
			const record = await ownRecord(handler.harness, request.handle, request.caller);
			// Stopping a child stops the children it spawned, and removes them all.
			const closed = new Set((await (await childOf(handler, record)).close(context)).map(String));
			await handler.harness.commit(async (tx) => {
				const state = await tx.doc(Children);

				const removed = new Set(
					Object.keys(state.children).filter((handle) => {
						const child = state.children[handle];

						return child !== undefined && closed.has(String(child.conversationId));
					}),
				);

				for (const handle of removed) delete state.children[handle];

				for (const [requestId, handle] of Object.entries(state.requests)) {
					if (removed.has(handle)) delete state.requests[requestId];
				}
			}, context);

			return record.name === undefined ? { handle: request.handle } : { handle: request.handle, name: record.name };
		}
	}
}

/** The request of a line from a client, checked against the protocol. */
function parseRequest(line: string): RequestLine {
	const request: unknown = JSON.parse(line);

	if (Value.Check(RequestLine, request)) return request;

	throw new Error(
		Value.Check(Type.Object({ type: Type.String() }), request)
			? `Unknown or invalid request: ${request.type}`
			: "Invalid request",
	);
}

async function spawnChild(request: Extract<RequestLine, { type: "spawn" }>, handler: Handler): Promise<ChildInfo> {
	if (!request.cwd) throw new Error("spawn requires a working directory");
	const { harness, place } = handler;
	const state = await harness.snapshot(Children, context);
	let handle = state?.requests[request.requestId];

	if (handle === undefined) {
		// A caller that is a child of this host or the project agent is the parent; any other caller is a root.
		const parent =
			(await library.lineage(harness, request.caller, context)) !== undefined ||
			request.caller === String(handler.root.id)
				? request.caller
				: undefined;

		let spec: Spec = {
			...(parent === undefined ? { root: request.caller } : { parent }),
			provider: request.provider,
			model: request.model,
			fallbackThinking: request.callerThinking,
			cwd: request.cwd,
			limit: await depthLimit(handler.settings),
		};

		if (request.thinking !== undefined) spec = { ...spec, thinking: request.thinking };

		if (request.tools !== undefined) spec = { ...spec, tools: request.tools };

		// The record is written in the commit that creates the child.
		await library.open(place, handler.owner, `sub:${request.requestId}`, spec, context, async (tx, id) => {
			const current = await tx.doc(Children);
			let fresh = randomBytes(3).toString("hex");

			while (Object.hasOwn(current.children, fresh)) fresh = randomBytes(3).toString("hex");
			const record: ChildRecord = { caller: request.caller, createdAt: new Date().toISOString(), conversationId: id };
			current.children[fresh] = request.name === undefined ? record : { name: request.name, ...record };
			current.requests[request.requestId] = fresh;
		});
		handle = (await harness.snapshot(Children, context))?.requests[request.requestId];

		if (handle === undefined) throw new Error(`Missing subagent of ${request.requestId}`);
	}

	const record = await childRecord(harness, handle);
	// The request ID makes a repeated spawn find the first submission, also after a crash before it.
	await (await childOf(handler, record)).send(
		{ type: "input", content: request.prompt, requestId: `spawn:${request.requestId}` },
		context,
	);
	await addSent(harness, handle, `spawn:${request.requestId}`, request);

	return childInfo(handler, handle, record);
}

/**
 * Sends the input of `request` to `found`. The verb comes from the conversation's own turn, so a child that only its
 * children hold is prompted.
 */
async function sendTo(
	request: Extract<RequestLine, { type: "send" | "input" }>,
	found: Pick<Found, "conversation" | "info" | "send">,
	harness: Harness,
): Promise<{ verb: string; child: ChildInfo }> {
	const busy = await turnRunning(harness, found.conversation.id);
	await found.send({
		type: "input",
		content: request.message,
		whenBusy: request.followUp ? "followUp" : "steer",
		requestId: request.requestId,
	});

	return { verb: sendVerb(busy, request.followUp), child: await found.info() };
}

/** Writes the note of `request` to its target. A note starts no turn, so its reply has no verb. */
async function noteTo(
	request: Extract<RequestLine, { type: "note" }>,
	handler: Handler,
): Promise<{ child: ChildInfo }> {
	const kind = request.kind ?? "harness.note";

	// pi-durable does not check the kind of a write.
	if (kind.startsWith("pi.")) throw new Error(`A note kind cannot start with "pi.": ${kind}`);
	const found = await target(handler, request);
	const model = [{ role: "user", content: request.text, timestamp: Date.now() }] as const;
	const entry: durable.EntryDraft = request.data === undefined ? { kind, model } : { kind, model, data: request.data };
	// The scope keeps a note from taking the request ID of an input to the same conversation.
	await found.write({ type: "write", requestId: `note:${request.requestId}`, entry });

	return { child: await found.info() };
}

function sendVerb(busy: boolean, followUp: boolean): string {
	return !busy ? "Prompted" : followUp ? "Queued follow-up for" : "Steered";
}

async function waitChild(
	request: Extract<RequestLine, { type: "wait" }>,
	handler: Handler,
): Promise<{ answer: string }> {
	const record = await childRecord(handler.harness, request.handle);
	const child = await childOf(handler, record);
	const timeout = AbortSignal.timeout(request.timeout * 1000);
	const signal = AbortSignal.any([timeout, handler.signal]);
	const waiting = withAbortSignal(signal, context);
	let text: UnreadAnswers;

	try {
		const { main, answer } = await handler.push.done(child, signal);
		// Read the record after the answer and after a push in flight: a send is in `sent` before it can be the last
		// request, and a push marks its answers read only once its reply is written.
		await handler.push.written(request.handle);
		const latest = await childRecord(handler.harness, request.handle);

		if (main !== null && main === latest.pushed) return { answer: NO_NEW_ANSWERS };
		text = await unreadAnswers(child, request.handle, latest, main, answer, record.sent ?? [], waiting);
		await markRead(handler.harness, request.handle, text.read);
	} catch (error) {
		if (timeout.aborted) throw new Error(`Timed out after ${request.timeout}s waiting for ${request.handle}`);
		throw error;
	}

	// A failed last turn is an error that still gives the earlier answers.
	if (text.failed) throw new Error(text.text);

	return { answer: text.text };
}

/**
 * The depth limit of a new subagent tree: `agentDepthLimit` in Pi's global settings, read again at each spawn. A child
 * of a child keeps the limit of its tree.
 */
async function depthLimit(settings: SettingsManager): Promise<number> {
	await settings.reload();
	const global = settings.getGlobalSettings();

	return Value.Check(DepthSetting, global) ? global.agentDepthLimit : DEPTH_LIMIT;
}

async function abortChild(request: Extract<RequestLine, { type: "abort" }>, handler: Handler): Promise<ChildInfo> {
	const found = await target(handler, request);
	// Without `background`, an abort of the project agent does not reach the anchors of the children, which keep running.
	await found.conversation.abort(context);

	return found.info();
}

async function configureChild(
	request: Extract<RequestLine, { type: "configure" }>,
	handler: Handler,
): Promise<ChildInfo> {
	// Only the handle: the schema of `configure` does not refuse an extra `conversation` key.
	const found = await target(handler, { handle: request.handle });
	const agent = await found.conversation.agent(context);
	await found.conversation.configure(resolveModel(handler.place.models, agent, request), context);

	return found.info();
}

/**
 * The root conversation as the agent of `project`. The first time, it gets Pi's default model when it has a login, else
 * the first model with a login, Pi's default thinking level, and the directory `cwd`. Without a model with a login, it
 * throws.
 */
async function setUpAgent(
	root: Conversation,
	models: Models,
	settings: SettingsManager,
	project: string,
	cwd: string,
): Promise<Conversation> {
	if ((await root.agent(context)).model !== undefined) return root;
	// A default set after the host started applies.
	await settings.reload();
	const available = await models.getAvailable();
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	const model = available.find((found) => found.provider === provider && found.id === modelId) ?? available[0];

	if (model === undefined) {
		throw new Error(
			`No model for the ${project} agent: log in to a provider and set a default model in Pi (defaultProvider and defaultModel)`,
		);
	}

	const resolved = resolveModel(models, undefined, {
		provider: model.provider,
		model: model.id,
		fallbackThinking: settings.getDefaultThinkingLevel() ?? "medium",
	});

	await root.configure({ ...resolved, cwd }, context);

	return root;
}

/**
 * Opens a watch of `handle` on `connection` and returns the reply, with the view and the child. After the reply, each
 * commit to the child's conversation gives one `{ event: WatchLine }` line with its change, and each rename one with
 * an empty change. It waits for a slow socket to drain, so pi-durable replaces the frames it holds back with one frame
 * of the whole view. The watches stop when the socket closes, when setup fails, or when the connection ends; a wait for
 * `drain` then stays on the closed socket and goes with it. When the child stops, the client gets a `stopped` event and the connection ends; when the conversation
 * watch ends for another reason, the connection ends.
 */
async function serveWatch(handler: Handler, ref: Target, connection: Connection): Promise<Replies["watch"]> {
	const handle = ref.conversation ?? ref.handle;
	const { harness } = handler;
	const { socket } = connection;
	const write = (event: WatchLine) => socket.write(`${JSON.stringify({ event })}\n`);
	// pi-durable stops both watches when `signal` aborts: on socket close, or when `watching` aborts.
	const watching = new AbortController();
	const watchContext = withAbortSignal(AbortSignal.any([handler.signal, watching.signal]), context);

	const end = () => {
		watching.abort();

		if (socket.writable) socket.end();
	};

	let found: Found;
	let children: DocumentWatch<ChildrenState> | undefined;
	let conversation: Awaited<ReturnType<Conversation["watch"]>>;
	let last: ChildInfo;

	try {
		found = await target(handler, ref);

		// The project agent and a conversation target have no record and no `Children` watch: they are never renamed
		// or stopped.
		if (found.record !== undefined) {
			// The `Children` watch opens before the info, so it gets each later rename and stop of the child.
			children = await harness.watchDoc(Children, watchContext);
			const record = recordOf(children?.value, handle);

			if (children === undefined || record === undefined) throw new Error(`Unknown subagent: ${handle}`);
			found = { ...found, record, info: () => childInfo(handler, handle, record) };
		}

		last = await found.info();
		conversation = await found.conversation.watch(watchContext);
	} catch (error) {
		watching.abort();
		throw error;
	}

	const childrenWatch = children;
	// pi-durable delivers the frames held before `start` in a microtask, so the watches start after the reply is written.
	connection.afterReply(() => {
		// Only microtasks run between the last `await` above and this call, so a socket close cannot abort the signal
		// before the watches start.
		void conversation.closed.then(end);
		// pi-durable runs the callbacks of one watch in order, but not those of two watches. Both watches write through
		// this one chain, so a line never has older info than the line before it.
		let queue: Promise<void> = Promise.resolve();

		const send = (change: ViewChange) => {
			queue = queue.then(async () => {
				// Some store reads per commit; cache the agent fields if streaming gets slow. A store failure drops this
				// line. A stopped child still gives `idle` here, and its `stopped` line follows.
				const child = await found.info().catch(() => undefined);

				if (child === undefined || !socket.writable) return;

				if (!write({ change, child })) await once(socket, "drain").catch(() => {});
			});

			return queue;
		};

		childrenWatch?.start(async (state) => {
			if (!socket.writable) return;
			const next = recordOf(state, handle);

			if (next === undefined) {
				write({ stopped: true });
				end();
			} else if (next.name !== found.record?.name) {
				found = { ...found, record: next, info: () => childInfo(handler, handle, next) };
				await send({});
			}
		});
		conversation.start((view, ops) => send(viewChange(view, ops)));
	});

	return { view: conversation.value, child: last };
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

	for (let grown = true; grown; ) {
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
