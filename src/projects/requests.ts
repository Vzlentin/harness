/**
 * The requests that the projects entry serves: one handler per request type of the project, and the `ask` requests,
 * with their parleys, in place of the plain asks of the host.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { EntryHandles, EntryOpen } from "../host/entries.ts";
import { type AnswerAuthorOf, type AskRequest, type ProjectRequest, type Replies } from "../protocol/requests.ts";
import { nextDigest, recordDigest } from "./digest.ts";
import { gateCall } from "./gate.ts";
import { stageItem, stageItems } from "./item-stage.ts";
import { addItem, linkItem, readItemBothWays, readItemWorkers, setItem, unlinkItem } from "./items.ts";
import { answerMemory, type HostMemory } from "./memory.ts";
import {
	dropAskRef,
	endParley,
	noteAskRef,
	readAsk,
	readParley,
	takeParley,
	writeAnswers,
	writeRound,
} from "./parleys.ts";
import { sendDeliveries } from "./project-deliveries.ts";
import { changeRule, setRule } from "./project-rules.ts";
import type { ProjectStore } from "./project-store.ts";
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
	readThread,
} from "./project.ts";
import { afterTurn, stopWork } from "./work-workers.ts";

const context = BACKGROUND_CONTEXT;

/** What the requests of the project use of the host, once it is open. */
export type ProjectsHost = Pick<
	EntryHandles,
	| "project"
	| "settings"
	| "degraded"
	| "warn"
	| "classifier"
	| "asks"
	| "liveWorkers"
	| "workers"
	| "labelledTasks"
	| "workersChange"
	| "stop"
	| "stopAfterTurn"
	| "endedChild"
	| "deliver"
> &
	EntryOpen & {
		readonly models: Models;
		/** The memory of the project agent, for the `memory` requests. */
		readonly memory: HostMemory;
		/**
		 * The persons, the threads, the messages, the rules, the held actions, the parleys, the items with their edges and
		 * the pending deliveries.
		 */
		readonly store: ProjectStore;
	};

/** A request of a type of the project that gets a reply: every type but the watch `watch-project`. */
export type HandledRequest = Exclude<ProjectRequest, { type: "watch-project" }>;

/** Handles `request`, a request of a type of the project but `watch-project`. */
export function handleProject<T extends HandledRequest["type"]>(
	request: Extract<HandledRequest, { type: T }>,
	host: ProjectsHost,
	signal: AbortSignal,
): Promise<Replies[T]>;
export async function handleProject(
	request: HandledRequest,
	host: ProjectsHost,
	signal: AbortSignal,
): Promise<Replies[HandledRequest["type"]]> {
	switch (request.type) {
		case "person":
			return person(request, host);
		case "thread":
			return thread(request, host);
		case "message":
			return message(request, host);
		case "digest":
			return digest(request.caller, request.head, host);
		case "rule":
			return rule(request, host);
		case "memory":
			return answerMemory(request, host.memory, signal);
		case "gate":
			return gateCall(request, { ...host, signal });
		case "held":
			return held(request, host);
		case "parley":
			return parley(request, host);
		case "item":
			return item(request, host);
	}
}

/**
 * Serves the `ask` request `request` with the parleys: an ask names its ask by ID or by its number in a parley, and a
 * round can frame a parley. `authorOf` gives the author of the answers of an `answer`.
 */
export async function projectAsk(
	request: AskRequest,
	host: ProjectsHost,
	authorOf: AnswerAuthorOf,
): Promise<Replies["ask"]> {
	switch (request.action) {
		case "round":
			return writeRound(host.harness, host.store, host.asks, request, request.caller, context);
		case "answer": {
			const author = await authorOf(request);

			return host.harness.commit(
				(tx) => writeAnswers(tx, host.store, host.asks, request.answers, request.caller, author, host.root.id),
				context,
			);
		}

		case "drop":
			return host.harness.commit((tx) => dropAskRef(tx, host.store, host.asks, request, request.caller), context);
		case "note":
			return host.harness.commit(
				(tx) => noteAskRef(tx, host.store, host.asks, request, request.note, request.caller),
				context,
			);
		case "read":
			return readAsk(host.harness, host.store, host.asks, request, context);
		case "list":
			return host.asks.open(host.harness, context);
	}
}

function person(request: Extract<ProjectRequest, { type: "person" }>, { store }: ProjectsHost): Replies["person"] {
	switch (request.action) {
		case "add":
			return store.write((tx) => addPerson(tx, request));
		case "list":
			return { persons: store.persons() };
	}
}

function thread(request: Extract<ProjectRequest, { type: "thread" }>, { store }: ProjectsHost): Replies["thread"] {
	switch (request.action) {
		case "add":
			return store.write((tx) => addThread(tx, request));
		case "list":
			return { threads: store.threads() };
		case "read":
			return readThread(store, request.id);
		case "join":
			return store.write((tx) => joinThread(tx, request));
	}
}

function message(request: Extract<ProjectRequest, { type: "message" }>, { store }: ProjectsHost): Replies["message"] {
	switch (request.action) {
		case "log":
			return store.write((tx) => logMessage(tx, request, request.caller));
		case "mark":
			return store.write((tx) => markMessage(tx, request, request.caller));
		case "edit":
			return store.write((tx) => editMessage(tx, request, request.caller));
		case "delete":
			return store.write((tx) => deleteMessage(tx, request));
	}
}

/** The digest of `caller` when it changed since its last one or `head` is new, recorded as given. */
async function digest(caller: string, head: string | undefined, host: ProjectsHost): Promise<Replies["digest"]> {
	const next = await nextDigest(host, caller, head);

	if (next === undefined) return {};
	await recordDigest(host.harness, caller, next);

	return { text: next.text };
}

function rule(request: Extract<ProjectRequest, { type: "rule" }>, { store }: ProjectsHost): Replies["rule"] {
	switch (request.action) {
		case "set":
			return store.write((tx) => setRule(tx, request, request.caller));
		case "list":
			return { rules: store.rules(request) };
		case "decide":
		case "retire":
		case "delete":
		case "edit":
		case "create": {
			const { type: _, caller, ...change } = request;

			return store.write((tx) => changeRule(tx, change, caller));
		}
	}
}

async function parley(
	request: Extract<ProjectRequest, { type: "parley" }>,
	host: ProjectsHost,
): Promise<Replies["parley"]> {
	switch (request.action) {
		case "take":
			return host.harness.commit((tx) => takeParley(tx, host.store, host.asks, request.slug, request.caller), context);
		case "end": {
			const ended = host.store.write((tx) => endParley(tx, request.slug, request.status, request.caller));

			await stopWork(host, [`parley:${ended.slug}`], afterTurn(request.caller));

			return ended;
		}

		case "read":
			return readParley(host.harness, host.store, host.asks, request.slug, context);
		case "list":
			return { parleys: host.store.parleys() };
	}
}

/**
 * Each item of a reply has its stage, which the entry works out after the write: the states of the agents are in the
 * commits of `durable.sqlite`.
 */
async function item(request: Extract<ProjectRequest, { type: "item" }>, host: ProjectsHost): Promise<Replies["item"]> {
	const { store } = host;

	switch (request.action) {
		case "add":
			return stageItem(
				host,
				store.write((tx) => addItem(tx, request, request.caller)),
			);
		case "set": {
			const workers = await readItemWorkers(host, request.id);
			const set = store.write((tx) => setItem(tx, request, request.caller, workers));

			// A closed item stops the workers of its label and of the contracts that it ended, and the caller after its turn.
			if (set.item.state !== "open") {
				const labels = [`item:${set.item.id}`, ...set.ended.map((slug) => `parley:${slug}`)];
				await stopWork(host, labels, afterTurn(request.caller));
			}

			return stageItem(host, set.item);
		}

		case "list":
			return { items: await stageItems(host, store.items(request.state ?? "open")) };
		case "read":
			return stageItem(host, readItemBothWays(store, request.id));
		case "link":
			return store.write((tx) => linkItem(tx, request, request.caller));
		case "unlink":
			return stageItem(
				host,
				store.write((tx) => unlinkItem(tx, request)),
			);
	}
}

/**
 * Approves or drops the held action of `request`. An approve by another caller than the agent of the action adds the
 * delivery that tells the agent, so that it calls the command again, and the request then sends the pending
 * deliveries (see `sendDeliveries`).
 */
async function held(request: Extract<ProjectRequest, { type: "held" }>, host: ProjectsHost): Promise<Replies["held"]> {
	const { id, caller } = request;

	if (request.action === "drop") return host.store.write((tx) => dropHeld(tx, id, caller));
	const approved = host.store.write((tx) => approveHeld(tx, id, caller));
	await sendDeliveries(host);

	return approved;
}
