/**
 * The requests of the host: one handler per request type, on the host's store, children and push, and the route of a
 * request of an entry type to the entry that serves it.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Input, Spec } from "../children/library.ts";
import { type ModelChoice, resolveModel, subagentModel } from "../children/model.ts";
import { approvedText, TYPED_KIND } from "../protocol/gate.ts";
import type { AnswerAuthor } from "../protocol/project.ts";
import {
	type ChildInfo,
	errorMessage,
	PROTOCOL_VERSION,
	type Replies,
	type Request,
	ThinkingLevel,
	versionMismatch,
} from "../protocol/requests.ts";
import { AGENT_HANDLE, type ListRef, parseTarget, type Target } from "../protocol/target.ts";
import { type CatchUpHost, catchUp } from "./agent.ts";
import { readOpenAsks } from "./asks.ts";
import { classifierModel, classifyTodos } from "./classify.ts";
import { nextDigest, recordDigest, writeDigest } from "./digest.ts";
import type { EntryLine, EntryRequest } from "./entries.ts";
import { serveEntryRequest } from "./entry-requests.ts";
import { gateCall } from "./gate.ts";
import { beforeInput, type InputHooksHost } from "./input-hooks.ts";
import { allItems, readItemBothWays, readItems } from "./item-docs.ts";
import { stageItem, stageItems } from "./item-stage.ts";
import { addItem, linkItem, serveItem, setItem, unlinkItem } from "./items.ts";
import { answerMemory, type HostMemory } from "./memory.ts";
import {
	dropAskRef,
	endParley,
	noteAskRef,
	readAsk,
	readParley,
	readParleys,
	takeParley,
	writeAnswers,
	writeRound,
} from "./parleys.ts";
import { changeRule, readRules, setRule } from "./project-rules.ts";
import { serveProjectWatch } from "./project-watch.ts";
import {
	addPerson,
	addThread,
	approveHeld,
	deleteMessage,
	dropHeld,
	editMessage,
	joinThread,
	logMessage,
	markMessage,
	readHeld,
	readPersons,
	readThread,
	readThreads,
} from "./project.ts";
import type { Connection, Push } from "./push.ts";
import { queryConversation } from "./query.ts";
import {
	addRecord,
	addRequest,
	callerHandle,
	ChildRecords,
	childRecord,
	markRead,
	ownRecord,
	recordsByAge,
	renameRecord,
	spawnedHandle,
	type UnreadAnswers,
	unreadAnswers,
} from "./records.ts";
import { servesOf } from "./serving.ts";
import type { Sessions } from "./sessions.ts";
import {
	callerConversation,
	childInfo,
	childOf,
	childTarget,
	endChildren,
	type Found,
	library,
	passiveEntry,
	refuseEnded,
	type SendOptions,
	stoppedEntry,
	type TargetHost,
	target,
	targetConversation,
	turnRunning,
} from "./targets.ts";
import { abortTask, startTask, type TaskHost, taskId, taskInfo, waitTask } from "./tasks.ts";
import { addTodo, readTodos, setTodo, type TodoOwner } from "./todo.ts";
import { serveTreeWatch } from "./tree-watch.ts";
import { treeNodes } from "./tree.ts";
import { serveWatch } from "./watch.ts";

const context = BACKGROUND_CONTEXT;

/** The depth limit of the subagent tree when Pi's global settings have no valid `agentDepthLimit`. */
const DEPTH_LIMIT = 4;
const DepthSetting = Type.Object({ agentDepthLimit: Type.Integer({ minimum: 1 }) });

const ThinkingSetting = Type.Object({ subagentThinkingLevel: ThinkingLevel });

/** The answer of a `wait` for a turn whose answer a push already gave. */
const NO_NEW_ANSWERS = "No new answers: the last answer came as a message.";

/** What every request of the host uses. */
export type Base = Omit<TaskHost, "signal"> &
	TargetHost &
	CatchUpHost &
	InputHooksHost & {
		/**
		 * Pi's settings, for the depth limit of the subagent tree, the default model and thinking level of a spawn, and the
		 * classifiers of the todos and of the gate, and the model of a query.
		 */
		readonly settings: SettingsManager;
		/** Writes a warning to the host's log. */
		readonly warn: (cause: unknown) => void;
		/** The versions of the protocols of the entries, by name, which the `hello` reply gives. */
		readonly entryVersions: Readonly<Record<string, number>>;
		/** The memory of the project agent, for the `memory` requests of the Pi sessions. */
		readonly memory: HostMemory;
		readonly push: Push;
		readonly sessions: Sessions;
		/**
		 * The storage of the harness: its entry lookup gives the thread of the source of an older rule, its reads of tasks
		 * and conversations give the tree, and its scan of documents gives the items.
		 */
		readonly storage: Pick<
			Storage,
			"entry" | "task" | "scanTasks" | "scanConversations" | "scanDocuments" | "findLatestHeadMarker"
		>;
	};

export type Handler = Base &
	TaskHost & {
		/** The socket of the request, and its hook after the reply. The in-process tool has none. */
		readonly connection?: Connection;
	};

/**
 * Handles `request`. Each target is parsed once with `parseTarget`: here, or in `todoOwner` for the list target of
 * `todo`, which can also be a task key or none.
 */
export function handleRequest<T extends Request["type"]>(
	request: Extract<Request, { type: T }>,
	handler: Handler,
): Promise<Replies[T]>;
export async function handleRequest(request: Request, handler: Handler): Promise<Replies[Request["type"]]> {
	switch (request.type) {
		case "hello":
			return hello(request, handler.entryVersions);
		case "spawn":
			return spawnChild(request, handler);
		case "send":
			return send(request, handler);
		case "input":
			return input(request, parseTarget(request), handler);
		case "note":
			return noteTo(request, parseTarget(request), handler);
		case "wait":
			return handler.push.whileActive(request.handle, () => waitChild(request, handler));
		case "answers":
			return answers(request, handler);
		case "status":
			return childInfo(handler, request.handle);
		case "abort":
			return abortChild(parseTarget(request), handler);
		case "query":
			return queryConversation(request, parseTarget(request), handler);
		case "configure":
			return configureChild(request, parseTarget(request), handler);
		case "watch":
			return watch(parseTarget(request), handler);
		case "start":
			return start(request, handler);
		case "task":
			return taskInfo(handler.harness, request.key);
		case "wait-task":
			return waitTask(handler, request.key);
		case "abort-task":
			return abortTask(handler.harness, request.key);
		case "todo":
			return todo(request, handler);
		case "classify-todos":
			return classify(request, handler);
		case "person":
			return person(request, handler);
		case "thread":
			return thread(request, handler);
		case "message":
			return message(request, handler);
		case "digest":
			return digest(request.caller, request.head, handler);
		case "rule":
			return rule(request, handler);
		case "memory":
			return answerMemory(request, handler.memory, handler.signal);
		case "gate":
			return gateCall(request, { ...handler, models: handler.place.models });
		case "held":
			return held(request, handler);
		case "ask":
			return ask(request, handler);
		case "parley":
			return parley(request, handler);
		case "item":
			return item(request, handler);
		case "tree":
			return { nodes: await treeNodes(handler) };
		case "watch-tree":
			return watchTree(handler);
		case "watch-project":
			return watchProject(handler);
		case "list":
			return list(request, handler);
		case "whoami":
			return whoami(request.caller, handler);
		case "rename":
			return rename(request, handler);
		case "stop":
			return stop(request, handler);
	}
}

/** A request line: a core request, or a line of a type that an entry serves, with that type. */
export type Line =
	| { readonly kind: "core"; readonly request: Request }
	| { readonly kind: "entry"; readonly request: EntryLine; readonly served: EntryRequest };

/** Handles `line`: a core request here, and a request of an entry type by the entry that serves it. */
export function handleLine(line: Line, handler: Handler): Promise<Replies[Request["type"]] | JsonValue> {
	if (line.kind === "core") return handleRequest(line.request, handler);

	return serveEntryRequest(line.served, line.request, handler.signal, handler.connection);
}

function hello(
	request: Extract<Request, { type: "hello" }>,
	entries: Readonly<Record<string, number>>,
): Replies["hello"] {
	if (request.version !== PROTOCOL_VERSION && request.external !== true) {
		throw new Error(versionMismatch(request.version, PROTOCOL_VERSION, process.pid));
	}

	return { version: PROTOCOL_VERSION, pid: process.pid, entries };
}

async function send(request: Extract<Request, { type: "send" }>, handler: Handler): Promise<Replies["send"]> {
	const { handle, requestId, notify } = request;
	const record = await ownRecord(handler.harness, handle, request.caller);

	return handler.push.whileActive(handle, async () => {
		const found = await childTarget(handler, handle, record);
		await beforeInput(handler, found);
		await writeDigest(handler, found);

		return sendTo(request, found, handler.harness, {
			// The request goes into the record's `requests` in the commit that makes it the last request, so a wait
			// that sees it as the last request finds it there.
			admitted: (tx) => addRequest(tx, handle, requestId, { notify }),
		});
	});
}

async function input(
	request: Extract<Request, { type: "input" }>,
	ref: Target,
	handler: Handler,
): Promise<Replies["input"]> {
	const found = await target(handler, ref);

	if (ref.kind === "agent") await catchUp(handler, found.write, request.requestId);
	await beforeInput(handler, found);
	await writeDigest(handler, found);

	// A conversation takes input only while it works, so its input is always a steer.
	return sendTo(ref.kind === "conversation" ? { ...request, followUp: false } : request, found, handler.harness);
}

async function answers(request: Extract<Request, { type: "answers" }>, handler: Handler): Promise<Replies["answers"]> {
	if (handler.connection === undefined) throw new Error("answers needs a connection");
	await handler.sessions.listen(request.caller, handler.connection.socket);

	return handler.push.listen(request.caller, handler.connection, handler.signal);
}

function watch(ref: Target, handler: Handler): Promise<Replies["watch"]> {
	if (handler.connection === undefined) throw new Error("A watch needs a connection");

	return serveWatch(handler, ref, handler.connection);
}

function watchTree(handler: Handler): Promise<Replies["watch-tree"]> {
	if (handler.connection === undefined) throw new Error("A tree watch needs a connection");

	return serveTreeWatch(handler, handler.connection);
}

function watchProject(handler: Handler): Promise<Replies["watch-project"]> {
	if (handler.connection === undefined) throw new Error("A project watch needs a connection");

	return serveProjectWatch(handler, handler.connection);
}

async function start(request: Extract<Request, { type: "start" }>, handler: Handler): Promise<Replies["start"]> {
	// A child that a task opens without a model takes the project agent's, so the agent is set up first. Without a model
	// for the agent, the task still starts: its children may name their own.
	await handler.agent().catch(() => undefined);

	return startTask(handler, request);
}

/** Adds, sets or lists the todos of the list that `request` targets. */
async function todo(request: Extract<Request, { type: "todo" }>, handler: Handler): Promise<Replies["todo"]> {
	const owner = await todoOwner(request, handler);

	switch (request.action) {
		case "add":
			return handler.harness.commit((tx) => addTodo(tx, owner, request.text), context);
		case "set":
			return handler.harness.commit((tx) => setTodo(tx, owner, request), context);
		case "list":
			return readTodos(handler.harness, owner, context);
	}
}

/**
 * The owner of the list that `request` targets: the task of a `start` key, a library conversation, the project agent,
 * a child by handle, or the caller. A caller that is a conversation of the host has the list of its conversation. The
 * project agent needs no set-up, and a child by handle needs no check of its caller.
 */
async function todoOwner(request: Extract<Request, { type: "todo" }>, handler: Handler): Promise<TodoOwner> {
	if (request.key !== undefined || request.handle !== undefined || request.conversation !== undefined) {
		return listOwner(request, handler);
	}

	const own = await callerConversation(handler, request.caller);

	return own === undefined ? { kind: "caller", caller: request.caller } : { kind: "conversation", id: own };
}

/**
 * The author of the answers of `request`: the user when the request has the mark `user`, else the agent of the
 * hosted conversation of the caller, else the agent of the caller.
 */
async function answerAuthor(
	request: Extract<Request, { type: "ask"; action: "answer" }>,
	handler: Handler,
): Promise<AnswerAuthor> {
	if (request.user === true) return { kind: "user" };
	const own = await callerConversation(handler, request.caller);

	return own === undefined ? { kind: "agent", caller: request.caller } : { kind: "hosted", conversation: own };
}

/** The owner of the list `ref`: the task of a `start` key, or the conversation of a handle or a conversation ID. */
async function listOwner(ref: ListRef, handler: Handler): Promise<TodoOwner> {
	if (ref.key !== undefined) return { kind: "task", id: await taskId(handler.harness, ref.key) };

	return { kind: "conversation", id: await targetConversation(handler, parseTarget(ref)) };
}

function person(request: Extract<Request, { type: "person" }>, handler: Handler): Promise<Replies["person"]> {
	switch (request.action) {
		case "add":
			return handler.harness.commit((tx) => addPerson(tx, request), context);
		case "list":
			return readPersons(handler.harness, context);
	}
}

function thread(request: Extract<Request, { type: "thread" }>, handler: Handler): Promise<Replies["thread"]> {
	switch (request.action) {
		case "add":
			return handler.harness.commit((tx) => addThread(tx, request), context);
		case "list":
			return readThreads(handler.harness, context);
		case "read":
			return readThread(handler.harness, request.id, context);
		case "join":
			return handler.harness.commit((tx) => joinThread(tx, request), context);
	}
}

function message(request: Extract<Request, { type: "message" }>, handler: Handler): Promise<Replies["message"]> {
	switch (request.action) {
		case "log":
			return handler.harness.commit((tx) => logMessage(tx, request, request.caller), context);
		case "mark":
			return handler.harness.commit((tx) => markMessage(tx, request, request.caller), context);
		case "edit":
			return handler.harness.commit((tx) => editMessage(tx, request, request.caller), context);
		case "delete":
			return handler.harness.commit((tx) => deleteMessage(tx, request, request.caller), context);
	}
}

/** The digest of `caller` when it changed since its last one or `head` is new, recorded as given. */
async function digest(caller: string, head: string | undefined, handler: Handler): Promise<Replies["digest"]> {
	const next = await nextDigest(handler, caller, head);

	if (next === undefined) return {};
	await recordDigest(handler.harness, caller, next);

	return { text: next.text };
}

function rule(request: Extract<Request, { type: "rule" }>, handler: Handler): Promise<Replies["rule"]> {
	switch (request.action) {
		case "set":
			return handler.harness.commit((tx) => setRule(tx, request, request.caller), context);
		case "list":
			return readRules(handler, request, context);
		case "decide":
		case "retire":
		case "delete":
		case "edit":
		case "create": {
			const { type: _, caller, ...change } = request;

			return handler.harness.commit((tx) => changeRule(tx, change, caller), context);
		}
	}
}

async function ask(request: Extract<Request, { type: "ask" }>, handler: Handler): Promise<Replies["ask"]> {
	switch (request.action) {
		case "round":
			return handler.harness.commit((tx) => writeRound(tx, request, request.caller), context);
		case "answer": {
			const author = await answerAuthor(request, handler);

			return handler.harness.commit(
				(tx) => writeAnswers(tx, request.answers, request.caller, author, handler.root.id),
				context,
			);
		}

		case "drop":
			return handler.harness.commit((tx) => dropAskRef(tx, request, request.caller), context);
		case "note":
			return handler.harness.commit((tx) => noteAskRef(tx, request, request.note, request.caller), context);
		case "read":
			return readAsk(handler.harness, request, context);
		case "list":
			return readOpenAsks(handler.harness, context);
	}
}

function parley(request: Extract<Request, { type: "parley" }>, handler: Handler): Promise<Replies["parley"]> {
	switch (request.action) {
		case "take":
			return handler.harness.commit((tx) => takeParley(tx, request.slug, request.caller), context);
		case "end":
			return handler.harness.commit(
				(tx) => endParley(tx, request.slug, request.status, request.caller, handler.items),
				context,
			);
		case "read":
			return readParley(handler.harness, request.slug, context);
		case "list":
			return readParleys(handler.harness, context);
	}
}

/**
 * Each item of a reply has its stage, which the host works out after the commit: a commit callback cannot read the
 * states of the agents, which their own commits give.
 */
async function item(request: Extract<Request, { type: "item" }>, handler: Handler): Promise<Replies["item"]> {
	switch (request.action) {
		case "add":
			return stageItem(handler, await handler.harness.commit((tx) => addItem(tx, request, request.caller), context));
		case "set":
			return stageItem(
				handler,
				await handler.harness.commit((tx) => setItem(tx, request, request.caller, handler.items), context),
			);
		case "list": {
			const items = await readItems(handler.harness, handler.storage, request.state ?? "open", context);

			return { items: await stageItems(handler, items) };
		}

		case "read":
			return stageItem(handler, await readItemBothWays(handler.harness, handler.storage, request.id, context));
		case "link":
			return handler.harness.commit((tx) => linkItem(tx, request, request.caller, handler.items), context);
		case "unlink":
			return stageItem(handler, await handler.harness.commit((tx) => unlinkItem(tx, request), context));
	}
}

/**
 * Approves or drops the held action of `request`. An approve tells the agent of the action with a follow-up input, so
 * that it calls the command again. The input is found before the commit, and a failed delivery is a warning and the
 * degraded state `approve-tell` of the action, until the action runs.
 */
async function held(request: Extract<Request, { type: "held" }>, handler: Handler): Promise<Replies["held"]> {
	const { id, caller } = request;

	if (request.action === "drop") return handler.harness.commit((tx) => dropHeld(tx, id, caller), context);
	const agent = (await readHeld(handler.harness, context)).held.find((found) => found.id === id)?.agent;
	const tell = agent === undefined ? undefined : await handler.push.inputOf(agent);
	const approved = await handler.harness.commit((tx) => approveHeld(tx, id, caller), context);

	await tell?.({
		type: "input",
		content: approvedText(approved),
		whenBusy: "followUp",
		requestId: `approve:${approved.id}`,
	}).catch((cause: unknown) => {
		handler.warn(cause);
		handler.degraded.start(
			"approve-tell",
			String(approved.id),
			`The tell of approved action ${approved.id} failed: ${errorMessage(cause)}`,
		);
	});

	return approved;
}

/**
 * The answers of the classifier about the open todos of the list of `request`, or without `list` about the open work
 * items, each with its title as its text. The classifier is found first, so a client without a credential gets that
 * error for any list.
 */
async function classify(
	request: Extract<Request, { type: "classify-todos" }>,
	handler: Handler,
): Promise<Replies["classify-todos"]> {
	const model = await classifierModel(handler.settings, handler.place.models, "todoClassifier", handler.degraded);

	const todos =
		request.list === undefined
			? (await allItems(handler.harness, handler.storage, context)).map(({ id, title, state }) => ({
					id,
					text: title,
					state,
				}))
			: (await readTodos(handler.harness, await listOwner(request.list, handler), context)).todos;

	return { answers: await classifyTodos(handler.place.models, model, todos, request.ids, handler.signal) };
}

async function list(request: Extract<Request, { type: "list" }>, handler: Handler): Promise<Replies["list"]> {
	const state = await handler.harness.snapshot(ChildRecords, context);

	const own = recordsByAge(state).filter(([, record]) => record.caller === request.caller);

	return Promise.all(own.map(([handle, record]) => childInfo(handler, handle, record)));
}

/**
 * The handle of `caller`: `agent` for the project agent, or the handle of the child whose conversation it is. Another
 * caller, such as a Pi session, gets no handle.
 */
async function whoami(caller: string, handler: Handler): Promise<Replies["whoami"]> {
	const state = await handler.harness.snapshot(ChildRecords, context);
	const handle = callerHandle(handler.root.id, recordsByAge(state), caller);

	return handle === undefined ? {} : { handle };
}

async function rename(request: Extract<Request, { type: "rename" }>, handler: Handler): Promise<Replies["rename"]> {
	await ownRecord(handler.harness, request.handle, request.caller);
	await renameRecord(handler.harness, request.handle, request.name);

	return childInfo(handler, request.handle);
}

/**
 * Stops the child of `request` with the children it spawned. For `cli`, a target with no record, the project agent or a
 * conversation such as a session of a task, has its turn aborted and stays.
 */
async function stop(request: Extract<Request, { type: "stop" }>, handler: Handler): Promise<Replies["stop"]> {
	const ref = parseTarget(request);
	const entry = await stoppedEntry(handler, ref, request.caller);

	if (entry === undefined) return { handle: (await abortTarget(ref, handler)).handle };

	const [handle, record] = entry;
	await endChildren(handler, [record], { keepAnswers: false });

	return record.name === undefined ? { handle } : { handle, name: record.name };
}

async function spawnChild(request: Extract<Request, { type: "spawn" }>, handler: Handler): Promise<ChildInfo> {
	const { harness, place } = handler;
	let handle = await spawnedHandle(harness, request.requestId);

	if (handle === undefined) {
		// A caller that is a child of this host or the project agent is the parent; any other caller is a root.
		const parent = (await callerConversation(handler, request.caller)) === undefined ? undefined : request.caller;

		const settings = await spawnSettings(handler.settings);
		const serves = await servesOf(handler, request.serves);

		let spec: Spec = {
			...(parent === undefined ? { root: request.caller } : { parent }),
			...spawnModel(request, settings.model),
			fallbackThinking: settings.thinking ?? request.callerThinking,
			cwd: request.cwd,
			limit: settings.limit,
		};

		if (request.thinking !== undefined) spec = { ...spec, thinking: request.thinking };

		if (request.tools !== undefined) spec = { ...spec, tools: request.tools };

		// A child that a `stop` of an older host removed keeps its key, ended, and has no record: a repeated spawn opens a
		// child under the next key. The keys are in a fixed order, so a retry after a crash finds the child that the first
		// try opened.
		for (let attempt = 0; handle === undefined; attempt += 1) {
			const key = attempt === 0 ? `sub:${request.requestId}` : `sub:${request.requestId}:${attempt}`;

			// The record, and the `serves` edge of an item, are written in the commit that creates the child.
			const opened = await library.open(place, handler.owner, key, spec, context, async (tx, id) => {
				await addRecord(tx, request.requestId, {
					caller: request.caller,
					conversationId: id,
					name: request.name,
					serves,
				});

				if (request.serves !== undefined && "item" in request.serves) {
					await serveItem(tx, request.serves.item, id, request.caller);
				}
			});

			handle = await spawnedHandle(harness, request.requestId);

			if (handle === undefined && (await opened.state(context)) !== "ended")
				throw new Error(`Missing subagent of ${request.requestId}`);
		}
	}

	const record = await childRecord(harness, handle);
	const requestId = `spawn:${request.requestId}`;
	const found = await childTarget(handler, handle, record);
	await beforeInput(handler, found);
	await writeDigest(handler, found);
	// The request ID makes a repeated spawn find the first submission, also after a crash before it. As for a `send`,
	// the request goes into the record's `requests` in the commit that makes it the last request.
	await found.send(
		{ type: "input", content: request.prompt, requestId },
		{
			admitted: (tx) => addRequest(tx, handle, requestId, { notify: request.notify }),
		},
	);

	return childInfo(handler, handle, record);
}

/**
 * Sends the input of `request` to `found`. The verb comes from the conversation's own turn, so a child that only its
 * children hold is prompted. The entry of an `input` has the kind `TYPED_KIND`, which the gate reads as the words of
 * the user; the entry of a `send` stays `pi.user`.
 */
async function sendTo(
	request: Extract<Request, { type: "send" | "input" }>,
	found: Pick<Found, "conversation" | "info"> & {
		readonly send: (input: Input, options?: SendOptions) => Promise<void>;
	},
	harness: Harness,
	options?: SendOptions,
): Promise<{ verb: string; child: ChildInfo }> {
	const busy = await turnRunning(harness, found.conversation.id);

	const input: Input = {
		type: "input",
		content: request.message,
		whenBusy: request.followUp ? "followUp" : "steer",
		requestId: request.requestId,
	};

	await found.send(request.type === "input" ? { ...input, entry: { kind: TYPED_KIND } } : input, options);

	return { verb: sendVerb(busy, request.followUp), child: await found.info() };
}

/** Writes the note of `request` to its target. A note starts no turn, so its reply has no verb. */
async function noteTo(
	request: Extract<Request, { type: "note" }>,
	ref: Target,
	handler: Handler,
): Promise<{ child: ChildInfo }> {
	const kind = request.kind ?? "harness.note";
	const found = await target(handler, ref);
	const entry = passiveEntry({ kind, text: request.text, data: request.data });
	// The scope keeps a note from taking the request ID of an input to the same conversation.
	await found.write({ type: "write", requestId: `note:${request.requestId}`, entry });

	return { child: await found.info() };
}

function sendVerb(busy: boolean, followUp: boolean): string {
	return !busy ? "Prompted" : followUp ? "Queued follow-up for" : "Steered";
}

async function waitChild(request: Extract<Request, { type: "wait" }>, handler: Handler): Promise<{ answer: string }> {
	const record = await childRecord(handler.harness, request.handle);
	const child = await childOf(handler, record);
	const timeout = AbortSignal.timeout(request.timeout * 1000);
	const signal = AbortSignal.any([timeout, handler.signal]);
	const waiting = withAbortSignal(signal, context);
	let text: UnreadAnswers;

	try {
		await refuseEnded(child);
		const { main, answer } = await handler.push.done(child, signal);
		// An end during the wait ends the turn with an abort, which is not the child's answer.
		await refuseEnded(child);
		// Read the record after the answer and after a push in flight: a send is in `requests` before it can be the last
		// request, and a push marks its answers read only once its reply is written.
		await handler.push.written(request.handle);
		const latest = await childRecord(handler.harness, request.handle);

		if (main !== null && main === latest.pushed) return { answer: NO_NEW_ANSWERS };
		text = await unreadAnswers(child, request.handle, latest, main, answer, record.requests, waiting);
		await markRead(handler.harness, request.handle, text.read);
	} catch (error) {
		if (timeout.aborted) throw new Error(`Timed out after ${request.timeout}s waiting for ${request.handle}`);
		throw error;
	}

	// A failed last turn is an error that still gives the earlier answers.
	if (text.failed) throw new Error(text.text);

	return { answer: text.text };
}

/** What Pi's global settings give a spawn. */
type SpawnSettings = {
	readonly limit: number;
	readonly model: ModelChoice | undefined;
	readonly thinking: Static<typeof ThinkingLevel> | undefined;
};

/**
 * The provider and the model of a spawn: those of the request when it gives either one, else `setting`. A missing part
 * comes from the caller.
 */
function spawnModel(request: Extract<Request, { type: "spawn" }>, setting: SpawnSettings["model"]): ModelChoice {
	const chosen: { readonly provider?: string | undefined; readonly model?: string | undefined } =
		request.provider !== undefined || request.model !== undefined ? request : (setting ?? {});

	const provider = chosen.provider ?? request.callerProvider;
	const model = chosen.model ?? request.callerModel;

	if (provider === undefined) throw new Error("No provider specified and the caller has no model");

	if (model === undefined) throw new Error("No model specified and the caller has no model");

	return { provider, model };
}

/**
 * What a spawn takes from Pi's global settings, read again at each spawn: the depth limit of a new subagent tree
 * (`agentDepthLimit`), and the default model (`subagentModel`, `provider/model`) and thinking level
 * (`subagentThinkingLevel`). A child of a child keeps the limit of its tree. Each key is checked alone: an invalid key
 * counts as absent.
 */
async function spawnSettings(settings: SettingsManager): Promise<SpawnSettings> {
	await settings.reload();
	const global = settings.getGlobalSettings();

	return {
		limit: Value.Check(DepthSetting, global) ? global.agentDepthLimit : DEPTH_LIMIT,
		model: subagentModel(settings),
		thinking: Value.Check(ThinkingSetting, global) ? global.subagentThinkingLevel : undefined,
	};
}

async function abortChild(ref: Target, handler: Handler): Promise<ChildInfo> {
	return (await abortTarget(ref, handler)).found.info();
}

/**
 * Aborts the turn of `ref`, and gives its target and its handle: `agent` for the project agent, else the ID of its
 * conversation. The handle does not come from the info, which fails for a conversation without a model or a working
 * directory.
 */
async function abortTarget(ref: Target, handler: Handler): Promise<{ readonly found: Found; readonly handle: string }> {
	const found = await target(handler, ref);
	// Without `background`, an abort of the project agent does not reach the anchors of the children, which keep running.
	await found.conversation.abort(context);

	return { found, handle: ref.kind === "agent" ? AGENT_HANDLE : String(found.conversation.id) };
}

async function configureChild(
	request: Extract<Request, { type: "configure" }>,
	ref: Target,
	handler: Handler,
): Promise<ChildInfo> {
	const found = await target(handler, ref);
	const agent = await found.conversation.agent(context);
	await found.conversation.configure(resolveModel(handler.place.models, agent, request), context);

	return found.info();
}
