import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import * as ai from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import {
	createEventBus,
	DefaultPackageManager,
	getAgentDir,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	createRegistry,
	type DocumentWatch,
	defineDoc,
	type Extension,
	Harness,
	type HarnessSettings,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	type Answer,
	type Child,
	createChildren,
	type Input,
	type Owner,
	type Place,
	resolveModel,
	type Spec,
} from "./children.ts";
import { ChildContext } from "./context.ts";
import {
	AGENT_HANDLE,
	type ChildInfo,
	type ChildState,
	type ModelInfo,
	onLines,
	PROTOCOL_VERSION,
	type Replies,
	type Reply,
	type Request,
	type WatchLine,
} from "./protocol.ts";
import { subagentTool } from "./tool.ts";

/** The root of this package, whose `piDurable` entry the host does not load. */
const PACKAGE_DIR = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));

/** The host exits after this long with no connection, no live task and no request. */
const IDLE_EXIT_MS = 5 * 60_000;
const IDLE_CHECK_MS = 60_000;
const context = BACKGROUND_CONTEXT;

type ChildRecord = {
	name?: string;
	/** `PI_SESSION_ID` of the spawner: a Pi session, the conversation ID of another child, or `cli`. */
	caller: string;
	createdAt: string;
	conversationId: ConversationId;
};

type ChildrenState = { children: Record<string, ChildRecord>; requests: Record<string, string> };

/**
 * The children by handle, and the handle of each spawn request ID. Version 2 leaves each child's last request to the
 * children library; a store with version 1 has children that the library does not know.
 */
const Children = defineDoc<ChildrenState>({
	kind: "subagent.children",
	version: 2,
	scope: "session",
	initial: () => ({ children: {}, requests: {} }),
});

/** The request ID of the project agent's newest input, which its `error` state comes from. */
const AgentState = defineDoc<{ lastRequest: string | null }>({
	kind: "harness.agent",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ lastRequest: null }),
});

/** The children library, on this process's pi-durable. */
const library = createChildren(durable);

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
}): Promise<Host | undefined> {
	const { stateDir, project, cwd, models } = options;
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const lock = takeLock(stateDir);
	if (lock === undefined) return undefined;
	const socketPath = join(stateDir, "host.sock");
	rmSync(socketPath, { force: true });

	const registry = createRegistry();
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(stateDir, agentDir, {
		projectTrusted: new ProjectTrustStore(agentDir).get(stateDir) === true,
	});
	const warn = (error: unknown) =>
		process.stderr.write(`warning: ${error instanceof Error ? error.message : String(error)}\n`);
	const entries = await loadEntries(stateDir, agentDir, settings, warn).catch((error: unknown) => {
		lock.close();
		throw error;
	});
	const envs = new Map<ConversationId, NodeExecutionEnv>();
	let harness: Harness;
	let base: Omit<Handler, "signal" | "connection">;
	// The project agent is the root conversation, set up at its first use. A failed set-up runs again at the next use.
	let agentSetUp: Promise<Conversation> | undefined;
	const agent = () =>
		(agentSetUp ??= setUpAgent(base.root, models, settings, project, cwd).catch((error: unknown) => {
			agentSetUp = undefined;
			throw error;
		}));
	// A child calls the host in this process, not through the socket, so a long `wait` cannot hold up the requests
	// of a connection. Its caller is its conversation ID, which the depth limit and the owner checks key on.
	const tool = subagentTool(durable, ai, {
		caller: async (api) => String(api.conversationId),
		send: (request, signal) => handleRequest(request, { ...base, signal }),
	});
	const selected = [ChildContext, tool, ...entries.extensions];
	try {
		for (const extension of selected) registry.install(extension);
		registry.install(library.extension);
		registry.install(library.answerExtension);
		harness = await Harness.open(
			await openNodeSqliteStorage(join(stateDir, "durable.sqlite")),
			{
				models,
				registry,
				settings: piSettings(settings, selected),
				env: async ({ conversationId, cwd, read }, envContext) => {
					if (cwd === undefined) return undefined;
					const cached = envs.get(conversationId);
					if (cached !== undefined) return cached;
					const agent = await read.snapshot(AgentDoc, conversationId, envContext);
					const shellEnv: NodeJS.ProcessEnv = { PI_SESSION_ID: String(conversationId), HARNESS_PROJECT: project };
					if (agent?.model !== undefined) {
						shellEnv.PI_PROVIDER = agent.model.provider;
						shellEnv.PI_MODEL = agent.model.modelId;
					}
					if (agent?.thinkingLevel !== undefined) shellEnv.PI_REASONING_LEVEL = agent.thinkingLevel;
					const env = new NodeExecutionEnv({ cwd, shellEnv });
					envs.set(conversationId, env);
					return env;
				},
				onReport: warn,
			},
			context,
		);
		// A store from before the children library would mix children that it does not know with those it does.
		// pi-durable refuses a stored version below the definition's with this message; any other error is not an old store.
		await harness.snapshot(Children, context).catch(async (error: unknown) => {
			await harness.close(context);
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("(subagent.children) requires migration from version")) throw error;
			throw new Error(
				`${join(stateDir, "durable.sqlite")} was written by an older pi-subagent (${message}). Stop the host, remove the file and run the command again.`,
			);
		});
	} catch (error) {
		await entries.close();
		lock.close();
		throw error;
	}
	harness.resume();
	const place: Place = {
		store: harness,
		models,
		get registry() {
			return registry.snapshot();
		},
	};
	// The host's children outlive every request: each has an anchor task in the root conversation. The anchors are
	// background tasks, so an abort of the root's turn, which is the project agent's, does not reach them.
	const root = await harness.root(context);
	base = { harness, place, owner: { kind: "detached", root }, root, project, agent };

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
				let start: (() => void) | undefined;
				const connection = { socket, afterReply: (afterReply: () => void) => (start = afterReply) };
				try {
					const request = JSON.parse(line) as Request;
					if (request.type !== "hello" && request.type !== "list" && request.type !== "status") {
						lastActivity = Date.now();
					}
					reply = {
						ok: true,
						value: await handleRequest(request, { ...base, signal: abort.signal, connection }),
					};
				} catch (error) {
					reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
				if (socket.writable) socket.write(`${JSON.stringify(reply)}\n`);
				start?.();
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
	}).catch(async (error: unknown) => {
		await entries.close();
		await harness.close(context);
		lock.close();
		throw error;
	});

	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			clearInterval(timer);
			server.close();
			for (const socket of connections) socket.destroy();
			for (const abort of aborts) abort.abort();
			try {
				// Entries close first: an entry may still need the open harness.
				await entries.close();
				await harness.close(context);
				for (const env of envs.values()) await env.cleanup(context);
			} finally {
				rmSync(socketPath, { force: true });
				lock.close();
			}
		})();
		return closing;
	};
	const timer = setInterval(() => {
		if (connections.size > 0 || Date.now() - lastActivity < IDLE_EXIT_MS) return;
		harness
			.inspect(context)
			.then(({ tasks }) => (tasks.length === 0 && connections.size === 0 ? close() : undefined))
			.catch(warn);
	}, IDLE_CHECK_MS);
	timer.unref();
	// A store failure closes the harness; the host then closes too.
	const closed = harness.closed.then(() => close());
	return { closed, close };
}

type Handler = {
	readonly harness: Harness;
	/** The host's store, models and tools, for the children library. */
	readonly place: Place;
	readonly owner: Owner;
	/** The root conversation, which owns the host's children and is the project agent. */
	readonly root: Conversation;
	readonly project: string;
	/** The project agent: the root conversation, with a model and the project directory from its first use. */
	readonly agent: () => Promise<Conversation>;
	/** Aborted when the connection of the request closes. */
	readonly signal: AbortSignal;
	/** The socket of the request, and a hook that runs `start` after the reply is written. The in-process tool has none. */
	readonly connection?: Connection;
};

type Connection = { readonly socket: Socket; afterReply(start: () => void): void };

function handleRequest<T extends Request["type"]>(
	request: Extract<Request, { type: T }>,
	handler: Handler,
): Promise<Replies[T]>;
async function handleRequest(request: Request, handler: Handler): Promise<Replies[Request["type"]]> {
	switch (request.type) {
		case "hello":
			return { version: PROTOCOL_VERSION, pid: process.pid };
		case "spawn":
			return spawnChild(request, handler);
		case "send":
			return sendTo(
				request,
				await childTarget(handler, request.handle, await ownRecord(handler.harness, request.handle, request.caller)),
			);
		case "input":
			return sendTo(request, await target(handler, request.handle));
		case "wait":
			return waitChild(request, handler);
		case "status":
			return childInfo(handler, request.handle);
		case "abort":
			return abortChild(request, handler);
		case "configure":
			return configureChild(request, handler);
		case "models":
			return modelInfos(handler.place.models);
		case "watch":
			if (handler.connection === undefined) throw new Error("A watch needs a connection");
			return serveWatch(handler, request.handle, handler.connection);
		case "list": {
			const state = await handler.harness.snapshot(Children, context);
			const own = Object.entries(state?.children ?? {})
				.filter(([, record]) => record.caller === request.caller)
				.sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
			return Promise.all(own.map(([handle, record]) => childInfo(handler, handle, record)));
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
			return { handle: request.handle, ...(record.name === undefined ? {} : { name: record.name }) };
		}
		default:
			throw new Error(`Unknown request: ${(request as { type?: unknown }).type}`);
	}
}

async function spawnChild(request: Extract<Request, { type: "spawn" }>, handler: Handler): Promise<ChildInfo> {
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
		const spec: Spec = {
			...(parent === undefined ? { root: request.caller } : { parent }),
			provider: request.provider,
			model: request.model,
			...(request.thinking === undefined ? {} : { thinking: request.thinking }),
			fallbackThinking: request.callerThinking,
			cwd: request.cwd,
			...(request.tools === undefined ? {} : { tools: request.tools }),
		};
		// The record is written in the commit that creates the child.
		await library.open(place, handler.owner, `sub:${request.requestId}`, spec, context, async (tx, id) => {
			const current = await tx.doc(Children);
			let fresh = randomBytes(3).toString("hex");
			while (Object.hasOwn(current.children, fresh)) fresh = randomBytes(3).toString("hex");
			current.children[fresh] = {
				...(request.name === undefined ? {} : { name: request.name }),
				caller: request.caller,
				createdAt: new Date().toISOString(),
				conversationId: id,
			};
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
	return childInfo(handler, handle, record);
}

/** Sends the input of `request` to `found`. */
async function sendTo(
	request: Extract<Request, { type: "send" | "input" }>,
	found: Pick<Target, "info" | "send">,
): Promise<{ verb: string; child: ChildInfo }> {
	const busy = (await found.info()).state === "busy";
	await found.send({
		type: "input",
		content: request.message,
		whenBusy: request.followUp ? "followUp" : "steer",
		requestId: request.requestId,
	});
	return { verb: sendVerb(busy, request.followUp), child: await found.info() };
}

function sendVerb(busy: boolean, followUp: boolean): string {
	return !busy ? "Prompted" : followUp ? "Queued follow-up for" : "Steered";
}

async function waitChild(request: Extract<Request, { type: "wait" }>, handler: Handler): Promise<{ answer: string }> {
	const child = await childOf(handler, await childRecord(handler.harness, request.handle));
	const timeout = AbortSignal.timeout(request.timeout * 1000);
	let answer: Answer;
	try {
		answer = await child.settled(withAbortSignal(AbortSignal.any([timeout, handler.signal]), context));
	} catch (error) {
		if (timeout.aborted) throw new Error(`Timed out after ${request.timeout}s waiting for ${request.handle}`);
		throw error;
	}
	// A cut answer still gives its text.
	if (answer.status === "ok" || answer.reason !== "unanswered") return { answer: answer.text };
	if (answer.cause === "queued") throw new Error(`${request.handle} stopped with queued messages after a failed turn`);
	throw new Error(failureText(request.handle, answer.cause, answer.detail));
}

async function abortChild(request: Extract<Request, { type: "abort" }>, handler: Handler): Promise<ChildInfo> {
	const found = await target(handler, request.handle);
	// Without `background`, an abort of the project agent does not reach the anchors of the children, which keep running.
	await found.conversation.abort(context);
	return found.info();
}

async function configureChild(request: Extract<Request, { type: "configure" }>, handler: Handler): Promise<ChildInfo> {
	const found = await target(handler, request.handle);
	const agent = await found.conversation.agent(context);
	await found.conversation.configure(resolveModel(handler.place.models, agent, request), context);
	return found.info();
}

/**
 * The conversation of `handle`, a child or the project agent, with its info, its input, and the record of a child.
 */
async function target(handler: Handler, handle: string) {
	if (handle !== AGENT_HANDLE) return childTarget(handler, handle, await childRecord(handler.harness, handle));
	const root = await handler.agent();
	const { harness, place, project } = handler;
	const turn = library.turn(
		place,
		root.id,
		root,
		async (readContext) => (await harness.snapshot(AgentState, root.id, readContext))?.lastRequest,
		async (tx, requestId) => {
			(await tx.doc(AgentState, root.id)).lastRequest = requestId;
		},
	);
	return {
		conversation: root,
		info: async (): Promise<ChildInfo> => ({
			...(await agentFields(root)),
			handle,
			name: `${project} agent`,
			state: await turn.state(context),
		}),
		send: (input: Input) => turn.send(input, context),
		record: undefined as ChildRecord | undefined,
	};
}

type Target = Awaited<ReturnType<typeof target>>;

/** The target of the child `handle`, whose record is `record`. */
async function childTarget(handler: Handler, handle: string, record: ChildRecord) {
	const child = await childOf(handler, record);
	return {
		conversation: child.conversation,
		info: () => childInfo(handler, handle, record),
		send: (input: Input) => child.send(input, context),
		record,
	};
}

async function modelInfos(models: Models): Promise<ModelInfo[]> {
	return (await models.getAvailable()).map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		thinkingLevels: getSupportedThinkingLevels(model),
	}));
}

async function childRecord(harness: Harness, handle: string): Promise<ChildRecord> {
	const state = await harness.snapshot(Children, context);
	const record = recordOf(state, handle);
	if (record === undefined) throw new Error(`Unknown subagent: ${handle}`);
	return record;
}

/** The record of `handle`, which must belong to `caller`. */
async function ownRecord(harness: Harness, handle: string, caller: string): Promise<ChildRecord> {
	const record = await childRecord(harness, handle);
	if (record.caller !== caller) throw new Error(`Subagent ${handle} belongs to another session`);
	return record;
}

async function childOf(handler: Pick<Handler, "place" | "owner">, record: ChildRecord): Promise<Child> {
	const child = await library.find(handler.place, handler.owner, { id: String(record.conversationId) }, context);
	if (child === undefined) throw new Error(`Missing conversation ${record.conversationId}`);
	return child;
}

function failureText(handle: string, reason: string, detail: unknown): string {
	if (reason === "aborted") return `${handle} was aborted`;
	const text =
		typeof detail === "string"
			? detail
			: typeof (detail as { message?: unknown } | undefined)?.message === "string"
				? (detail as { message: string }).message
				: undefined;
	return text === undefined ? `${handle} failed: ${reason}` : `${handle} failed: ${text}`;
}

/** The info of `handle`. A caller that already has the record gives it as `record`. */
async function childInfo(
	handler: Pick<Handler, "harness" | "place" | "owner">,
	handle: string,
	record?: ChildRecord,
): Promise<ChildInfo> {
	record ??= await childRecord(handler.harness, handle);
	const child = await childOf(handler, record);
	const childState = await child.state(context);
	// A closed child is idle: the watch can still send it before its record goes and the `stopped` line follows.
	const state: ChildState = childState === "closed" ? "idle" : childState;
	return {
		handle,
		...(record.name === undefined ? {} : { name: record.name }),
		state,
		...(await agentFields(child.conversation)),
	};
}

/** The model, thinking level and directory of the agent of `conversation`, for its info. */
async function agentFields(
	conversation: Conversation,
): Promise<Pick<ChildInfo, "provider" | "model" | "thinking" | "cwd">> {
	const agent = await conversation.agent(context);
	return {
		provider: agent.model?.provider ?? "",
		model: agent.model?.modelId ?? "",
		thinking: agent.thinkingLevel,
		// `spawnChild` refuses a spawn without `cwd`; the fallback only satisfies pi-durable's optional type.
		cwd: agent.cwd ?? "",
	};
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
 * commit to the child's conversation and each rename gives one `{ event: WatchLine }` line. It waits for a slow socket
 * to drain, so pi-durable replaces the frames it holds back with one frame of the whole view. The watches stop when the
 * socket closes, when setup fails, or when the connection ends; a wait for `drain` then stays on the closed socket and
 * goes with it. When the child stops, the viewer gets a `stopped` event and the connection ends; when the conversation
 * watch ends for another reason, the connection ends.
 */
async function serveWatch(handler: Handler, handle: string, connection: Connection): Promise<Replies["watch"]> {
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
	let found: Target;
	let children: DocumentWatch<ChildrenState> | undefined;
	let conversation: Awaited<ReturnType<Conversation["watch"]>>;
	let last: ChildInfo;
	try {
		found = await target(handler, handle);
		// The project agent has no record, and no `Children` watch: it is never renamed or stopped.
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
		const send = (ops: readonly Op[]) => {
			queue = queue.then(async () => {
				// Some store reads per commit; cache the agent fields if streaming gets slow. A store failure drops this
				// line. A stopped child still gives `idle` here, and its `stopped` line follows.
				const child = await found.info().catch(() => undefined);
				if (child === undefined || !socket.writable) return;
				if (!write({ ops, child })) await once(socket, "drain").catch(() => {});
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
				await send([]);
			}
		});
		conversation.start((_view, ops) => send(ops));
	});
	return { view: conversation.value, child: last };
}

/** The record of `handle` in the `Children` value `state`. */
function recordOf(state: Readonly<ChildrenState> | null | undefined, handle: string): ChildRecord | undefined {
	return state != null && Object.hasOwn(state.children, handle) ? state.children[handle] : undefined;
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
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get retry() {
			return settings.getRetrySettings();
		},
		get compaction() {
			return settings.getCompactionSettings();
		},
	};
}

/** What the default export of a `piDurable` entry returns. */
type Entry = { readonly extensions: readonly Extension[]; close(): Promise<void> };

/**
 * The `piDurable` entries of the installed packages in Pi's `settingsManager` for `cwd`, in one shared event bus, as one
 * entry whose `close()` closes each of them and passes its errors to `warn`. When an entry fails to load, the entries
 * loaded before it close. Missing packages are skipped, not installed. Node does not strip types under
 * `node_modules`, so entries of npm packages fail to load.
 */
async function loadEntries(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	warn: (error: unknown) => void,
): Promise<Entry> {
	const roots = new Set(
		new DefaultPackageManager({ cwd, agentDir, settingsManager })
			.listConfiguredPackages()
			.flatMap((found) => found.installedPath ?? []),
	);
	const events = createEventBus();
	const entries: Entry[] = [];
	const close = async () => {
		for (const result of await Promise.allSettled(entries.map((entry) => entry.close()))) {
			if (result.status === "rejected") warn(result.reason);
		}
	};
	try {
		for (const root of roots) {
			const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}")) as {
				readonly piDurable?: { readonly extensions?: readonly string[] };
			};
			// The host installs its own tool, with its own caller.
			if ((await realpath(root).catch(() => root)) === PACKAGE_DIR) continue;
			for (const path of manifest.piDurable?.extensions ?? []) {
				const entry = await import(pathToFileURL(resolvePath(root, path)).href);
				entries.push(await entry.default({ durable, ai, events }));
			}
		}
	} catch (error) {
		await close();
		throw error;
	}
	return { extensions: entries.flatMap((entry) => entry.extensions), close };
}
