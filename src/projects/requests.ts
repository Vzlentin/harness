/**
 * The requests that the projects entry serves: one handler per request type of the project, and the `ask` requests,
 * with their parleys, in place of the plain asks of the host.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Input } from "../children/library.ts";
import type { EntryHandles, EntryOpen } from "../host/entries.ts";
import { approvedText } from "../protocol/gate.ts";
import {
	type AnswerAuthorOf,
	type AskRequest,
	errorMessage,
	type ProjectRequest,
	type Replies,
} from "../protocol/requests.ts";
import { nextDigest, recordDigest } from "./digest.ts";
import { gateCall } from "./gate.ts";
import { readItemBothWays, readItems } from "./item-docs.ts";
import type { ItemIndex } from "./item-index.ts";
import { stageItem, stageItems } from "./item-stage.ts";
import { addItem, linkItem, readItemWorkers, setItem, unlinkItem } from "./items.ts";
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
	readPersons,
	readThread,
	readThreads,
} from "./project.ts";
import { stopWork } from "./work-workers.ts";

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
	| "tell"
> &
	EntryOpen & {
		/** The index of the ends of the items, which gives the items that a contract shapes. */
		readonly items: ItemIndex;
		readonly models: Models;
		/** The memory of the project agent, for the `memory` requests. */
		readonly memory: HostMemory;
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
			return host.harness.commit((tx) => writeRound(tx, host.asks, request, request.caller), context);
		case "answer": {
			const author = await authorOf(request);

			return host.harness.commit(
				(tx) => writeAnswers(tx, host.asks, request.answers, request.caller, author, host.root.id),
				context,
			);
		}

		case "drop":
			return host.harness.commit((tx) => dropAskRef(tx, host.asks, request, request.caller), context);
		case "note":
			return host.harness.commit((tx) => noteAskRef(tx, host.asks, request, request.note, request.caller), context);
		case "read":
			return readAsk(host.harness, host.asks, request, context);
		case "list":
			return host.asks.open(host.harness, context);
	}
}

function person(request: Extract<ProjectRequest, { type: "person" }>, host: ProjectsHost): Promise<Replies["person"]> {
	switch (request.action) {
		case "add":
			return host.harness.commit((tx) => addPerson(tx, request), context);
		case "list":
			return readPersons(host.harness, context);
	}
}

function thread(request: Extract<ProjectRequest, { type: "thread" }>, host: ProjectsHost): Promise<Replies["thread"]> {
	switch (request.action) {
		case "add":
			return host.harness.commit((tx) => addThread(tx, request), context);
		case "list":
			return readThreads(host.harness, context);
		case "read":
			return readThread(host.harness, request.id, context);
		case "join":
			return host.harness.commit((tx) => joinThread(tx, request), context);
	}
}

function message(
	request: Extract<ProjectRequest, { type: "message" }>,
	host: ProjectsHost,
): Promise<Replies["message"]> {
	switch (request.action) {
		case "log":
			return host.harness.commit((tx) => logMessage(tx, request, request.caller), context);
		case "mark":
			return host.harness.commit((tx) => markMessage(tx, request, request.caller), context);
		case "edit":
			return host.harness.commit((tx) => editMessage(tx, request, request.caller), context);
		case "delete":
			return host.harness.commit((tx) => deleteMessage(tx, request, request.caller), context);
	}
}

/** The digest of `caller` when it changed since its last one or `head` is new, recorded as given. */
async function digest(caller: string, head: string | undefined, host: ProjectsHost): Promise<Replies["digest"]> {
	const next = await nextDigest(host, caller, head);

	if (next === undefined) return {};
	await recordDigest(host.harness, caller, next);

	return { text: next.text };
}

function rule(request: Extract<ProjectRequest, { type: "rule" }>, host: ProjectsHost): Promise<Replies["rule"]> {
	switch (request.action) {
		case "set":
			return host.harness.commit((tx) => setRule(tx, request, request.caller), context);
		case "list":
			return readRules(host, request, context);
		case "decide":
		case "retire":
		case "delete":
		case "edit":
		case "create": {
			const { type: _, caller, ...change } = request;

			return host.harness.commit((tx) => changeRule(tx, change, caller), context);
		}
	}
}

async function parley(
	request: Extract<ProjectRequest, { type: "parley" }>,
	host: ProjectsHost,
): Promise<Replies["parley"]> {
	switch (request.action) {
		case "take":
			return host.harness.commit((tx) => takeParley(tx, host.asks, request.slug, request.caller), context);
		case "end": {
			const ended = await host.harness.commit(
				(tx) => endParley(tx, request.slug, request.status, request.caller, host.items),
				context,
			);

			await stopWork(host, [`parley:${ended.slug}`], { caller: request.caller });

			return ended;
		}

		case "read":
			return readParley(host.harness, host.asks, request.slug, context);
		case "list":
			return readParleys(host.harness, context);
	}
}

/**
 * Each item of a reply has its stage, which the entry works out after the commit: a commit callback cannot read the
 * states of the agents, which their own commits give.
 */
async function item(request: Extract<ProjectRequest, { type: "item" }>, host: ProjectsHost): Promise<Replies["item"]> {
	switch (request.action) {
		case "add":
			return stageItem(host, await host.harness.commit((tx) => addItem(tx, request, request.caller), context));
		case "set": {
			const workers = await readItemWorkers(host, request.id);

			const set = await host.harness.commit((tx) => setItem(tx, request, request.caller, host.items, workers), context);

			// A closed item stops the workers of its label and of the contracts that it ended, and the caller after its turn.
			if (set.item.state !== "open") {
				await stopWork(host, [`item:${set.item.id}`, ...set.ended.map((slug) => `parley:${slug}`)], {
					caller: request.caller,
				});
			}

			return stageItem(host, set.item);
		}

		case "list": {
			const items = await readItems(host.harness, host.storage, request.state ?? "open", context);

			return { items: await stageItems(host, items) };
		}

		case "read":
			return stageItem(host, await readItemBothWays(host.harness, host.storage, request.id, context));
		case "link":
			return host.harness.commit((tx) => linkItem(tx, request, request.caller, host.items), context);
		case "unlink":
			return stageItem(host, await host.harness.commit((tx) => unlinkItem(tx, request), context));
	}
}

/**
 * Approves or drops the held action of `request`. An approve tells the agent of the action with a follow-up input, so
 * that it calls the command again. A failed delivery is a warning and the degraded state `approve-tell` of the action,
 * until the action runs.
 */
async function held(request: Extract<ProjectRequest, { type: "held" }>, host: ProjectsHost): Promise<Replies["held"]> {
	const { id, caller } = request;

	if (request.action === "drop") return host.harness.commit((tx) => dropHeld(tx, id, caller), context);
	const approved = await host.harness.commit((tx) => approveHeld(tx, id, caller), context);

	const input: Input = {
		type: "input",
		content: approvedText(approved),
		whenBusy: "followUp",
		requestId: `approve:${approved.id}`,
	};

	await host.tell(approved.agent, input).catch((cause: unknown) => {
		host.warn(cause);
		host.degraded.start(
			"approve-tell",
			String(approved.id),
			`The tell of approved action ${approved.id} failed: ${errorMessage(cause)}`,
		);
	});

	return approved;
}
