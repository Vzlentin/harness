/**
 * The requests of the host: one handler per request type, on the host's store, children and push.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type * as durable from "@earendil-works/pi-durable";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Input, Spec } from "../children/library.ts";
import { resolveModel } from "../children/model.ts";
import { type ChildInfo, PROTOCOL_VERSION, type Replies, type Request, versionMismatch } from "../protocol/requests.ts";
import { type ListRef, parseTarget, type Target } from "../protocol/target.ts";
import {
	cutAnswer,
	MAX_LIVE_CHILDREN,
	overInput,
	SEND_TOO_LARGE,
	SPAWN_TOO_LARGE,
	TOO_MANY_LIVE,
} from "../rlm/limits.ts";
import { type CatchUpHost, catchUp } from "./agent.ts";
import { classifyTodos, todoClassifier } from "./classify.ts";
import type { Connection, Push } from "./push.ts";
import {
	addRecord,
	addRequest,
	callerHandle,
	type ChildRecord,
	ChildRecords,
	childRecord,
	markRead,
	ownRecord,
	recordsByAge,
	removeRecords,
	renameRecord,
	spawnedHandle,
	type UnreadAnswers,
	unreadAnswers,
} from "./records.ts";
import {
	callerConversation,
	childInfo,
	childOf,
	childTarget,
	type Found,
	library,
	type SendOptions,
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

/** The answer of a `wait` for a turn whose answer a push already gave. */
const NO_NEW_ANSWERS = "No new answers: the last answer came as a message.";

/** What every request of the host uses. */
export type Base = Omit<TaskHost, "signal"> &
	TargetHost &
	CatchUpHost & {
		/** Pi's settings, for the depth limit of the subagent tree and the classifier of the todos. */
		readonly settings: SettingsManager;
		readonly push: Push;
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
			return hello(request);
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
		case "tree":
			return { nodes: await treeNodes(handler) };
		case "watch-tree":
			return watchTree(handler);
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

function hello(request: Extract<Request, { type: "hello" }>): Replies["hello"] {
	if (request.version !== PROTOCOL_VERSION) {
		throw new Error(versionMismatch(request.version, PROTOCOL_VERSION, process.pid));
	}

	return { version: PROTOCOL_VERSION, pid: process.pid };
}

async function send(request: Extract<Request, { type: "send" }>, handler: Handler): Promise<Replies["send"]> {
	const { handle, requestId, notify } = request;
	const record = await ownRecord(handler.harness, handle, request.caller);

	if (record.kind === "rlm" && overInput(request.message)) throw new Error(SEND_TOO_LARGE);

	return handler.push.whileActive(handle, async () =>
		sendTo(request, await childTarget(handler, handle, record), handler.harness, {
			// The request goes into the record's `requests` in the commit that makes it the last request, so a wait
			// that sees it as the last request finds it there.
			admitted: (tx) => addRequest(tx, handle, requestId, { notify }),
		}),
	);
}

async function input(
	request: Extract<Request, { type: "input" }>,
	ref: Target,
	handler: Handler,
): Promise<Replies["input"]> {
	const found = await target(handler, ref);

	if (ref.kind === "agent") await catchUp(handler, found.write, request.requestId);

	// A conversation takes input only while it works, so its input is always a steer.
	return sendTo(ref.kind === "conversation" ? { ...request, followUp: false } : request, found, handler.harness);
}

function answers(request: Extract<Request, { type: "answers" }>, handler: Handler): Promise<Replies["answers"]> {
	if (handler.connection === undefined) throw new Error("answers needs a connection");

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

/** The owner of the list `ref`: the task of a `start` key, or the conversation of a handle or a conversation ID. */
async function listOwner(ref: ListRef, handler: Handler): Promise<TodoOwner> {
	if (ref.key !== undefined) return { kind: "task", id: await taskId(handler.harness, ref.key) };

	return { kind: "conversation", id: await targetConversation(handler, parseTarget(ref)) };
}

/**
 * The answers of the classifier about the open todos of the list of `request`, default the list of the project. The
 * classifier is found first, so a client without a credential gets that error for any list.
 */
async function classify(
	request: Extract<Request, { type: "classify-todos" }>,
	handler: Handler,
): Promise<Replies["classify-todos"]> {
	const model = await todoClassifier(handler.settings, handler.place.models);

	const owner: TodoOwner =
		request.list === undefined ? { kind: "conversation", id: handler.root.id } : await listOwner(request.list, handler);

	const { todos } = await readTodos(handler.harness, owner, context);

	return { answers: await classifyTodos(handler.place.models, model, todos, request.ids, handler.signal) };
}

async function list(request: Extract<Request, { type: "list" }>, handler: Handler): Promise<Replies["list"]> {
	const state = await handler.harness.snapshot(ChildRecords, context);

	const own = recordsByAge(state).filter(([, record]) => record.caller === request.caller);

	// A child that the library closed outside `stop`, such as a subagent of a workflow session when its run ends, keeps
	// its record until a `stop`, and is not listed.
	const infos = await Promise.all(
		own.map(async ([handle, record]) =>
			(await (await childOf(handler, record)).state(context)) === "closed"
				? undefined
				: childInfo(handler, handle, record),
		),
	);

	return infos.filter((info) => info !== undefined);
}

/** The handle of `caller`: `agent` for the project agent, or the handle of the child whose conversation it is. */
async function whoami(caller: string, handler: Handler): Promise<Replies["whoami"]> {
	const state = await handler.harness.snapshot(ChildRecords, context);
	const handle = callerHandle(handler.root.id, recordsByAge(state), caller);

	if (handle === undefined) throw new Error(`The caller ${caller} is not a child or the project agent of this host`);

	return { handle };
}

async function rename(request: Extract<Request, { type: "rename" }>, handler: Handler): Promise<Replies["rename"]> {
	await ownRecord(handler.harness, request.handle, request.caller);
	await renameRecord(handler.harness, request.handle, request.name);

	return childInfo(handler, request.handle);
}

async function stop(request: Extract<Request, { type: "stop" }>, handler: Handler): Promise<Replies["stop"]> {
	const record = await ownRecord(handler.harness, request.handle, request.caller);
	await stopChild(handler, record);

	return record.name === undefined ? { handle: request.handle } : { handle: request.handle, name: record.name };
}

/** Closes the child of `record` and the children it spawned, and removes their records. A repeat finishes a stop. */
async function stopChild(handler: Handler, record: ChildRecord): Promise<void> {
	const closed = new Set((await (await childOf(handler, record)).close(context)).map(String));
	await removeRecords(handler.harness, closed);
}

async function spawnChild(request: Extract<Request, { type: "spawn" }>, handler: Handler): Promise<ChildInfo> {
	const { harness, place } = handler;

	if (request.kind === "rlm" && overInput(request.prompt)) throw new Error(SPAWN_TOO_LARGE);
	let handle = await spawnedHandle(harness, request.requestId);

	// A stop that ended between its close and the removal of the records leaves the record of a closed child: the stop is
	// finished, and the spawn opens a new child.
	if (handle !== undefined) {
		const found = await childRecord(harness, handle);

		if ((await (await childOf(handler, found)).state(context)) === "closed") {
			await stopChild(handler, found);
			handle = undefined;
		}
	}

	if (handle === undefined) {
		// A caller that is a child of this host or the project agent is the parent; any other caller is a root.
		const parent = (await callerConversation(handler, request.caller)) === undefined ? undefined : request.caller;

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

		// A stopped child keeps its key, closed, and `stop` removed its record: a repeated spawn opens a child under the
		// next key. The keys are in a fixed order, so a retry after a crash finds the child that the first try opened.
		for (let attempt = 0; handle === undefined; attempt += 1) {
			const key = attempt === 0 ? `sub:${request.requestId}` : `sub:${request.requestId}:${attempt}`;

			// The record is written in the commit that creates the child. Commits run one at a time, so the count of the live
			// RLM children there holds for spawns at the same time.
			const opened = await library.open(place, handler.owner, key, spec, context, async (tx, id) => {
				if (request.kind === "rlm") await refuseLiveOverflow(tx, request.caller);

				await addRecord(tx, request.requestId, {
					caller: request.caller,
					conversationId: id,
					name: request.name,
					kind: request.kind,
				});
			});

			handle = await spawnedHandle(harness, request.requestId);

			if (handle === undefined && (await opened.state(context)) !== "closed")
				throw new Error(`Missing subagent of ${request.requestId}`);
		}
	}

	const record = await childRecord(harness, handle);
	const requestId = `spawn:${request.requestId}`;
	// The request ID makes a repeated spawn find the first submission, also after a crash before it. As for a `send`,
	// the request goes into the record's `requests` in the commit that makes it the last request.
	await (
		await childOf(handler, record)
	).send({ type: "input", content: request.prompt, requestId }, context, {
		admitted: (tx) => addRequest(tx, handle, requestId, { notify: request.notify }),
	});

	return childInfo(handler, handle, record);
}

/**
 * Refuses a new RLM child of `caller` in `tx`, the commit that creates it, when the caller has `MAX_LIVE_CHILDREN` RLM
 * children that are not closed. A closed child can keep its record, such as after a close of its parent.
 */
async function refuseLiveOverflow(tx: Tx, caller: string): Promise<void> {
	const own = Object.values((await tx.doc(ChildRecords)).children).filter(
		(record) => record.caller === caller && record.kind === "rlm",
	);

	const closed = await Promise.all(own.map((record) => library.closed(tx, record.conversationId)));

	if (closed.filter((isClosed) => !isClosed).length >= MAX_LIVE_CHILDREN) throw new Error(TOO_MANY_LIVE);
}

/**
 * Sends the input of `request` to `found`. The verb comes from the conversation's own turn, so a child that only its
 * children hold is prompted.
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
	await found.send(
		{
			type: "input",
			content: request.message,
			whenBusy: request.followUp ? "followUp" : "steer",
			requestId: request.requestId,
		},
		options,
	);

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
	const model = [{ role: "user", content: request.text, timestamp: Date.now() }] as const;
	const entry: durable.EntryDraft = request.data === undefined ? { kind, model } : { kind, model, data: request.data };
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

	const refuseClosed = async () => {
		if ((await child.state(context)) === "closed") throw new Error(`The child ${child.id} is closed`);
	};

	try {
		await refuseClosed();
		const { main, answer } = await handler.push.done(child, signal);
		// A close during the wait ends the turn with an abort, which is not the child's answer.
		await refuseClosed();
		// Read the record after the answer and after a push in flight: a send is in `requests` before it can be the last
		// request, and a push marks its answers read only once its reply is written.
		await handler.push.written(request.handle);
		const latest = await childRecord(handler.harness, request.handle);

		if (main !== null && main === latest.pushed) return { answer: NO_NEW_ANSWERS };
		const cut = record.kind === "rlm" ? cutAnswer : undefined;
		text = await unreadAnswers(child, request.handle, latest, main, answer, record.requests, waiting, cut);
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

async function abortChild(ref: Target, handler: Handler): Promise<ChildInfo> {
	const found = await target(handler, ref);
	// Without `background`, an abort of the project agent does not reach the anchors of the children, which keep running.
	await found.conversation.abort(context);

	return found.info();
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
