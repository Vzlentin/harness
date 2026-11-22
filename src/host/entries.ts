/**
 * The entries that the host loads: the `piDurable` entries of Pi's packages and the entries of `entries.json`. Each
 * entry is a module whose default export gets the host's handles, and gives extensions, tasks, a catch-up hook, an input
 * hook, a handler of the answered asks, a handler of the reports of the workers, a handler of the ended children, the
 * request types that it serves, the checks of its label kinds, the version of its protocol, its open and busy calls, the
 * handler of the `ask` requests and the list that `classify-todos` takes without `list` to the host.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import * as ai from "@earendil-works/pi-ai";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import {
	createEventBus,
	DefaultPackageManager,
	type EventBus,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	AnyTask,
	CommitChange,
	Conversation,
	ConversationId,
	DocumentReader,
	Extension,
	Harness,
	Storage,
	Tx,
} from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { createChildren, Input, Place } from "../children/library.ts";
import { readEntries } from "../protocol/entries.ts";
import type { AnswerAuthor, AnswerInput, Ask, AskInput, AskList } from "../protocol/project.ts";
import { type AnswerAuthorOf, type AskRequest, type GroupAnswers, Json, type Replies } from "../protocol/requests.ts";
import type { Todo, TodoList } from "../protocol/todo.ts";
import type { WorkerId, Worker } from "../protocol/worker-labels.ts";
import type { DurableScope } from "../tool.ts";
import type { ClassifierKey } from "./classify.ts";
import type { Degraded } from "./degraded.ts";
import type { LabelCheck } from "./label-checks.ts";
import type { ConnectionWatchOptions } from "./store-watch.ts";
import type { CallerTodoList } from "./todo-lists.ts";

type ChildrenLibrary = ReturnType<typeof createChildren>;

/**
 * What a catch-up hook gives for one catch-up: `seen`, what the agent has seen now, which the next catch-up gives the
 * hook back; `lines`, the facts for the agent, none when nothing is new; and `data`, the same facts for the entry.
 */
export const CatchUpPart = Type.Object({
	seen: Json,
	lines: Type.Array(Type.String()),
	data: Type.Optional(Json),
});

export type CatchUpPart = Static<typeof CatchUpPart>;

/**
 * The catch-up hook of an entry. Before each input of the project agent, the host calls `run` with what the hook said
 * the agent saw at the last catch-up, or nothing the first time. `kind` names the hook's state and data. The hooks of
 * `loadEntries` check the part of `run`: an invalid part throws.
 */
const CatchUpHook = Type.Object({
	kind: Type.String({ minLength: 1 }),
	run: Type.Unsafe<(harness: Harness, seen: JsonValue | undefined) => Promise<CatchUpPart>>(
		Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()),
	),
});

export type CatchUpHook = Static<typeof CatchUpHook>;

/**
 * The entry that an input hook writes: `key` names it in the request ID `input:<hook kind>:<key>`, so a repeat adds
 * nothing; `kind` is the kind of the entry, `text` its words for the model, and `data` its data.
 */
export const InputWrite = Type.Object({
	key: Type.String({ minLength: 1 }),
	kind: Type.String({ minLength: 1 }),
	text: Type.String(),
	data: Type.Optional(Json),
});

export type InputWrite = Static<typeof InputWrite>;

/**
 * What an input hook gets before an input: the ID of the conversation, the ID of the newest head marker of its context
 * (a compaction or a reset), and `write`, which writes at most one passive user entry before the input.
 */
export type InputHookCall = {
	readonly conversation: string;
	readonly head: string | undefined;
	readonly write: (write: InputWrite) => Promise<void>;
};

/** The input hook of an entry, which runs before each input of a hosted conversation. `kind` names it. */
const InputHook = Type.Object({
	kind: Type.String({ minLength: 1 }),
	run: Type.Unsafe<(call: InputHookCall) => Promise<void>>(Type.Function([Type.Unknown()], Type.Unknown())),
});

export type InputHook = Static<typeof InputHook>;

/** An answered ask that the handler of an entry gets: its key `answer:<n>`, and the ask with its answer. */
export type AnsweredAskEvent = { readonly key: string; readonly ask: Ask };

/** The handler of the answered asks of an entry. */
export type AnsweredAskHandler = (event: AnsweredAskEvent, options: { readonly signal: AbortSignal }) => Promise<void>;

/**
 * A report of the result references of a worker that the handler of an entry gets: the worker, its labels, the
 * references of the report, repeats included, and the caller of the report.
 */
export type ReportedEvent = {
	readonly worker: WorkerId;
	readonly labels: readonly string[];
	readonly refs: readonly string[];
	readonly caller: string;
};

/**
 * The handler of the reports of an entry. It runs after the commit of the report and the handlers of the entries that
 * loaded before it, before the reply. A throw fails the request, the later handlers do not run, and the references stay
 * stored.
 */
export type ReportedHandler = (event: ReportedEvent) => Promise<void>;

/** A child of the host that ended, by its conversation ID, which the handler of an entry gets. */
export type AgentEndedEvent = { readonly conversation: string };

/**
 * The handler of the ended children of an entry. The host gives each end once and keeps no queue of these events: an
 * entry that must see every end checks the children that ended at its `open`, with `endedChild`. A child can end twice,
 * such as after a resume, so a handler must do nothing for an end that it already handled.
 */
export type AgentEndedHandler = (event: AgentEndedEvent) => Promise<void>;

/** A request line of a type that an entry serves: a JSON object with its type. */
export const EntryLine = Type.Intersect([Type.Object({ type: Type.String() }), Type.Record(Type.String(), Json)]);

export type EntryLine = Static<typeof EntryLine>;

/** What a watch of an entry gets. */
export type EntryWatchOptions = ConnectionWatchOptions<JsonValue>;

/** The fields of a request type of an entry: its type, the schema of its lines, and whether a line is passive. */
const EntryRequestFields = {
	type: Type.String({ minLength: 1 }),
	schema: Type.Unsafe<TSchema>(Type.Object({})),
	/** Whether the line `request` does not count as activity for the idle exit. */
	passive: Type.Unsafe<(request: EntryLine) => boolean>(Type.Function([Type.Unknown()], Type.Unknown())),
};

/**
 * A request type of an entry, with exactly one of `handle`, which gives the reply, and `watch`, which gives the state
 * as the reply and then sends events.
 */
const EntryRequest = Type.Union([
	Type.Object({
		...EntryRequestFields,
		handle: Type.Unsafe<(request: EntryLine, options: { readonly signal: AbortSignal }) => Promise<JsonValue>>(
			Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()),
		),
		watch: Type.Optional(Type.Never()),
	}),
	Type.Object({
		...EntryRequestFields,
		watch: Type.Unsafe<(request: EntryLine, options: EntryWatchOptions) => Promise<JsonValue>>(
			Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()),
		),
		handle: Type.Optional(Type.Never()),
	}),
]);

export type EntryRequest = Static<typeof EntryRequest>;

/**
 * The check of the labels of the kind `kind` of an entry. Before a spawn of a child or a first start of a task with
 * such a label, the host calls `check`, which throws the reason when it refuses the label, and the spawn or the start
 * fails with it.
 */
const LabelKind = Type.Object({
	kind: Type.String({ minLength: 1 }),
	check: Type.Unsafe<LabelCheck>(Type.Function([Type.Unknown()], Type.Unknown())),
});

/** What the host gives the open call of an entry: the open harness, its root conversation and its storage. */
export type EntryOpen = { readonly harness: Harness; readonly root: Conversation; readonly storage: Storage };

/**
 * The handler of the `ask` requests of an entry, which serves them in place of the host. Its `author` gives the author
 * of the answers of an `answer`, as the host works it out.
 */
export type AskHandler = (
	request: AskRequest,
	options: { readonly signal: AbortSignal; readonly author: AnswerAuthorOf },
) => Promise<Replies["ask"]>;

/** The name and the version of the protocol of an entry, which the `hello` reply gives. */
const EntryProtocol = Type.Object({ name: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }) });

/**
 * What the default export of an entry returns: its extensions, the tasks that `start` runs, its catch-up hook, its
 * input hook, its handler of the answered asks, its handler of the reports, its handler of the ended children, the
 * request types that it serves, the checks of its label kinds, the version of its protocol, `open`, which the host
 * calls once the root conversation and the workers are there and before any task resumes, `busy`, which keeps the host
 * from its idle exit, the handler of the `ask` requests, the list of `classify-todos` without `list`, and `close`.
 */
const EntryResult = Type.Object({
	extensions: Type.Unsafe<readonly Extension[]>(Type.Array(Type.Unknown())),
	tasks: Type.Optional(Type.Unsafe<readonly AnyTask[]>(Type.Array(Type.Unknown()))),
	catchUp: Type.Optional(CatchUpHook),
	input: Type.Optional(InputHook),
	answeredAsk: Type.Optional(
		Type.Unsafe<AnsweredAskHandler>(Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown())),
	),
	reported: Type.Optional(Type.Unsafe<ReportedHandler>(Type.Function([Type.Unknown()], Type.Unknown()))),
	agentEnded: Type.Optional(Type.Unsafe<AgentEndedHandler>(Type.Function([Type.Unknown()], Type.Unknown()))),
	requests: Type.Optional(Type.Array(EntryRequest)),
	labels: Type.Optional(Type.Array(LabelKind)),
	protocol: Type.Optional(EntryProtocol),
	open: Type.Optional(
		Type.Unsafe<(opened: EntryOpen) => Promise<void>>(Type.Function([Type.Unknown()], Type.Unknown())),
	),
	busy: Type.Optional(Type.Unsafe<() => boolean>(Type.Function([], Type.Unknown()))),
	ask: Type.Optional(Type.Unsafe<AskHandler>(Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()))),
	classifyList: Type.Optional(Type.Unsafe<() => Promise<readonly Todo[]>>(Type.Function([], Type.Unknown()))),
	close: Type.Unsafe<() => Promise<void>>(Type.Function([], Type.Unknown())),
});

export type Entry = Static<typeof EntryResult>;

/**
 * The entries that the host loaded, as one: their extensions, tasks, catch-up hooks, input hooks, handlers of the
 * answered asks and handlers of the reports in load order, the handler of the `ask` requests and the list of
 * `classify-todos`, each of at most one entry, their request types by type, the checks of their labels by kind, the
 * versions of their protocols by name, the event bus that they share, `open`, which opens each entry in load order,
 * `agentEnded`, which gives an ended child to the handler of each entry in load order, `busy`, true while an entry is
 * busy, and `close`.
 */
export type LoadedEntries = {
	readonly extensions: readonly Extension[];
	readonly tasks: readonly AnyTask[];
	readonly catchUps: readonly CatchUpHook[];
	readonly inputHooks: readonly InputHook[];
	readonly answeredAsks: readonly AnsweredAskHandler[];
	readonly reported: readonly ReportedHandler[];
	readonly ask: AskHandler | undefined;
	readonly classifyList: (() => Promise<readonly Todo[]>) | undefined;
	open(opened: EntryOpen): Promise<void>;
	/** Gives the child `conversation` that ended to the handler of each entry. A handler that throws is a warning. */
	readonly agentEnded: (conversation: string) => Promise<void>;
	busy(): boolean;
	readonly requests: ReadonlyMap<string, EntryRequest>;
	readonly labelChecks: ReadonlyMap<string, LabelCheck>;
	readonly versions: Readonly<Record<string, number>>;
	readonly events: EventBus;
	close(): Promise<void>;
};

/** The classifier models of Pi's settings, and the questions to them, with the host's settings, models and states. */
export type EntryClassifier = {
	/** The model of the setting `key`, as the classifiers of the host find it. */
	model(key: ClassifierKey): Promise<ClassifierModel<ClassifierApi>>;
	/** The answers of `model` in `context`. */
	ask(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		signal: AbortSignal,
	): Promise<ClassifierResult["answers"]>;
};

/** A new ask: its question, and the parley that it serves when it serves one, as data that the host does not read. */
export type NewAsk = { readonly input: AskInput; readonly parley?: NonNullable<Ask["parley"]> };

/** The answer of the ask `id`. */
export type AskAnswer = Extract<AnswerInput, { readonly id: number }>;

/**
 * The asks of the store. The writes take the `Tx` of a commit of the entry, so they go in one commit with the writes
 * of the entry. They need no open host.
 */
export type EntryAsks = {
	/** Every ask, in ID order. */
	readonly read: (reader: Pick<DocumentReader, "snapshot">, context: Context) => Promise<AskList>;
	/** The open asks, in ID order. */
	readonly open: (reader: Pick<DocumentReader, "snapshot">, context: Context) => Promise<AskList>;
	/** Every ask in `tx`, in ID order. The writes of the asks in `tx` change the list. */
	readonly inCommit: (tx: Tx) => Promise<readonly Ask[]>;
	/** Adds an open ask for each of `asks`, asked at `at` by the caller `by`, each with the next ID, and gives them. */
	readonly add: (tx: Tx, asks: readonly NewAsk[], by: string, at: number) => Promise<Ask[]>;
	/**
	 * Writes the answers `answers` of `author` for the caller `by`, and gives the answered asks, in the order of
	 * `answers`. The asks of `confirms` take `own` and `ok`, and get no todo `Save to the vault`; the other answered
	 * asks get one in the list of their asker, where `root` is the project agent. The same commit queues the deliveries
	 * that `group` makes of the answered asks whose asker is not `by`, and one event for each answered ask.
	 */
	readonly answer: (
		tx: Tx,
		answers: readonly AskAnswer[],
		confirms: ReadonlySet<number>,
		by: string,
		author: AnswerAuthor,
		root: ConversationId,
		group: GroupAnswers,
	) => Promise<Ask[]>;
	/** Drops the open ask `id` for the caller `by`, and gives it. An ask that is not open fails. */
	readonly drop: (tx: Tx, id: number, by: string) => Promise<Ask>;
	/**
	 * Sets `note`, the ID of a note in the vault, on the ask `id` for its asker `by`, and gives the ask. The note sets
	 * the todo `Save to the vault` of the ask to done.
	 */
	readonly note: (tx: Tx, id: number, note: string, by: string) => Promise<Ask>;
	/**
	 * Makes the caller `by` the asker of each open ask of `ids`, and removes the answers of the asks of `ids` that wait
	 * to go to their askers.
	 */
	readonly take: (tx: Tx, ids: readonly number[], by: string) => Promise<void>;
	/** Adds the asks of a store file, with their IDs, to the asks of `tx`. */
	readonly load: (tx: Tx, asks: readonly Ask[]) => Promise<void>;
};

/** The lists of todos of the store. They need no open host. */
export type EntryTodos = {
	/** Whether `reader` has a list of the conversation `id`. A read of a list in a commit creates a missing list. */
	readonly has: (reader: Pick<DocumentReader, "snapshot">, id: ConversationId, context: Context) => Promise<boolean>;
	/** The list of the conversation `id` in `tx`, which the commit writes with its changes. */
	readonly draft: (tx: Tx, id: ConversationId) => Promise<TodoList>;
	/** The list of the conversation `id`, empty when it has none. */
	readonly read: (reader: Pick<DocumentReader, "snapshot">, id: ConversationId, context: Context) => Promise<TodoList>;
	/** The list of each caller that has one, by caller, which the scan of `storage`, the storage of `reader`, finds. */
	readonly callers: (
		reader: Pick<DocumentReader, "snapshot">,
		storage: Pick<Storage, "scanDocuments">,
		context: Context,
	) => Promise<CallerTodoList[]>;
	/** Whether `change`, a change of a commit, can change the list of the conversation `id` or the list of a caller. */
	readonly changed: (change: CommitChange, id: ConversationId) => boolean;
	/**
	 * Writes `todos` to the list of the root conversation `root` in `tx`, and the list of each caller of
	 * `callerTodos`, also an empty one, into a store whose lists are empty.
	 */
	readonly load: (
		tx: Tx,
		root: ConversationId,
		todos: readonly Todo[],
		callerTodos: readonly CallerTodoList[],
	) => Promise<void>;
};

/** The handles of the host that each entry gets, the same object for each. */
export type EntryHandles = {
	/** The state directory of the project. */
	readonly stateDir: string;
	/** The name of the project. */
	readonly project: string;
	/** The working directory of the project. */
	readonly cwd: string;
	/** Pi's settings for the project directory, as the host reads them. */
	readonly settings: SettingsManager;
	/**
	 * The scope of the tools of the hosted conversations: its `send` serves a typed request in this process, by the host
	 * or by the entry of its type, with no check of its schema. A watch type needs a connection, and fails.
	 */
	readonly scope: DurableScope;
	/**
	 * Sends `input` to `caller` when it is a conversation of the host (the project agent, a child or a library
	 * conversation), after the input hooks. It resumes an ended conversation. Another caller, such as a Pi session, gets
	 * nothing. It throws until the host is open.
	 */
	readonly tell: (caller: string, input: Input) => Promise<void>;
	/** The live workers of each label. It throws until the host is open. */
	readonly liveWorkers: () => Promise<ReadonlyMap<string, readonly Worker[]>>;
	readonly asks: EntryAsks;
	readonly todos: EntryTodos;
	/** The degraded states of the host. */
	readonly degraded: Degraded;
	/** Writes a warning to the host's log. */
	readonly warn: (cause: unknown) => void;
	readonly classifier: EntryClassifier;
	/**
	 * Sends `text` once for each `key` to `to`: as input to a hosted conversation (the project agent, a child or a library
	 * conversation), or in the reply to the `answers` request of a Pi session. It throws until the host is open, and
	 * `UnknownDeliveryTarget` for another `to`.
	 */
	readonly deliver: (delivery: EntryDelivery) => Promise<void>;
	/** The live workers of `label`. It throws until the host is open. */
	readonly workers: (label: string) => Promise<readonly Worker[]>;
	/** The keys of the started tasks of each label, in any state of the task. It throws until the host is open. */
	readonly labelledTasks: () => Promise<ReadonlyMap<string, readonly string[]>>;
	/**
	 * Whether `change`, a change of a commit of the store, can change a live worker of a label: a change of a child, of
	 * the record of a child, of the started tasks or of the labels of the tasks, or a task that ends. It reads nothing.
	 */
	readonly workersChange: (change: CommitChange) => boolean;
	/**
	 * Adds `label` to the labels of the child whose conversation ID is `conversation`, once, with no check of the label,
	 * and gives whether the host has such a child. It is for the move of an old store, whose children got their labels
	 * before the spawn checked them. It throws until the host is open.
	 */
	readonly labelChild: (conversation: string, label: string) => Promise<boolean>;
	/** Whether the conversation `conversation` is a child of the host that ended. It throws until the host is open. */
	readonly endedChild: (conversation: string) => Promise<boolean>;
	/**
	 * Stops `worker`: a child with the children that it spawned, or a task. A worker that already ended is left as it is.
	 * It throws until the host is open.
	 */
	readonly stop: (worker: Worker) => Promise<void>;
	/**
	 * Stops the agent `worker` as `stop` does, after the turn that it runs: at the commit that ends its turn, or at once
	 * when it runs no turn. It rejects when the session closes first. It throws until the host is open.
	 */
	readonly stopAfterTurn: (worker: Extract<Worker, { readonly kind: "agent" }>) => Promise<void>;
};

/** A delivery of an entry: the text that goes to the conversation or Pi session `to` once for the key `key`. */
export const EntryDelivery = Type.Object({
	key: Type.String({ minLength: 1 }),
	to: Type.String({ minLength: 1 }),
	text: Type.String({ minLength: 1 }),
});

export type EntryDelivery = Static<typeof EntryDelivery>;

/** The error of `deliver` for a `to` that is not a conversation or a Pi session of the host. */
export class UnknownDeliveryTarget extends Error {
	override readonly name = "UnknownDeliveryTarget";

	constructor(to: string) {
		super(`${to} is not a conversation or a Pi session of the host`);
	}
}

/** What the host gives the default export of an entry. */
export type EntryOptions = EntryHandles & {
	readonly durable: typeof durable;
	readonly ai: typeof ai;
	readonly events: EventBus;
	readonly children: ChildrenLibrary;
	readonly place: Place;
};

/** A `package.json`, which is a JSON object. */
const PackageJson = Type.Object({});

/** The part of a package's `package.json` that names its entries. */
const Manifest = Type.Object({
	piDurable: Type.Optional(Type.Object({ extensions: Type.Optional(Type.Array(Type.String())) })),
});

/**
 * The `piDurable` entries of the installed packages in Pi's `settingsManager` for `cwd`, then the entries of
 * `entries.json` (see `readEntries`), with the children library `children` and the host's `handles`, in one shared
 * event bus, as one entry whose `close()` closes each of them and passes its errors to `handles.warn`. When an entry
 * fails to load, returns an invalid result, gives the kind of catch-up hook or input hook, a request type or the protocol
 * name of an earlier entry, gives a handler of the `ask` requests or the list of
 * `classify-todos` when an earlier entry gave one, serves a request type of `coreTypes`, which the host owns, or checks
 * the label kind of an earlier entry, the entries loaded before it close.
 * Missing packages are skipped, not installed, and so is an entry module of `entries.json` that does not exist, such as
 * one of an uninstalled package, with a warning. A package or an entry that it skips is a degraded state in
 * `handles.degraded` for the life of the host.
 */
export async function loadEntries(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	place: Place,
	children: ChildrenLibrary,
	coreTypes: ReadonlySet<string>,
	handles: EntryHandles,
): Promise<LoadedEntries> {
	const { warn, degraded } = handles;
	const modules = new Set<string>();

	const roots = new DefaultPackageManager({ cwd, agentDir, settingsManager })
		.listConfiguredPackages()
		.flatMap((found) => found.installedPath ?? []);

	for (const root of new Set(roots)) {
		const path = join(root, "package.json");
		const manifest: unknown = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));

		if (!Value.Check(PackageJson, manifest)) {
			degraded.warn("package-skipped", path, `${path} is not a valid package.json`);
			continue;
		}

		if (!Value.Check(Manifest, manifest)) {
			degraded.warn("package-skipped", path, `${path} has an invalid piDurable field`);
			continue;
		}

		for (const path of manifest.piDurable?.extensions ?? []) modules.add(resolvePath(root, path));
	}

	for (const [name, module] of Object.entries(readEntries())) {
		if (existsSync(module)) {
			modules.add(module);
			continue;
		}

		degraded.warn("entry-skipped", name, `The entry ${name} has no module at ${module}; the host skips it`);
	}

	const events = createEventBus();
	const entries: Entry[] = [];
	/**
	 * The module of each catch-up hook kind, input hook kind, request type, label kind and protocol name, and of the ask
	 * handler and the report handler.
	 */
	const owners = new Map<string, string>();
	const requests = new Map<string, EntryRequest>();
	const labelChecks = new Map<string, LabelCheck>();
	const versions: Record<string, number> = {};

	const close = async () => {
		for (const result of await Promise.allSettled(entries.map((entry) => entry.close()))) {
			if (result.status === "rejected") warn(result.reason);
		}
	};

	try {
		for (const module of modules) {
			const entry = await importEntry(module);
			const result: unknown = await entry.default({ ...handles, durable, ai, events, children, place });

			if (!Value.Check(EntryResult, result)) {
				throw new Error(
					`The entry ${module} returned an invalid result: ${invalidReason(Value.Errors(EntryResult, result))}`,
				);
			}

			entries.push(result);
			const kind = result.catchUp?.kind;

			if (kind !== undefined) claim(owners, module, "give the catch-up hook", kind);

			if (result.input !== undefined) claim(owners, module, "give the input hook", result.input.kind);

			if (result.ask !== undefined) claim(owners, module, "give the handler of the", "ask requests");

			if (result.classifyList !== undefined) claim(owners, module, "give the list of", "classify-todos");

			for (const request of result.requests ?? []) {
				if (coreTypes.has(request.type)) {
					throw new Error(`The entry ${module} serves the request type ${request.type}, which the host owns`);
				}

				claim(owners, module, "serve the request type", request.type);
				requests.set(request.type, request);
			}

			for (const { kind, check } of result.labels ?? []) {
				claim(owners, module, "check the label kind", kind);
				labelChecks.set(kind, check);
			}

			if (result.protocol !== undefined) {
				claim(owners, module, "give the protocol", result.protocol.name);
				versions[result.protocol.name] = result.protocol.version;
			}
		}
	} catch (error) {
		await close();
		throw error;
	}

	return {
		extensions: entries.flatMap((entry) => entry.extensions),
		tasks: entries.flatMap((entry) => entry.tasks ?? []),
		catchUps: entries.flatMap((entry) => (entry.catchUp === undefined ? [] : [checkedHook(entry.catchUp)])),
		inputHooks: entries.flatMap((entry) => entry.input ?? []),
		answeredAsks: entries.flatMap((entry) => entry.answeredAsk ?? []),
		reported: entries.flatMap((entry) => entry.reported ?? []),
		ask: entries.find((entry) => entry.ask !== undefined)?.ask,
		classifyList: entries.find((entry) => entry.classifyList !== undefined)?.classifyList,
		open: async (opened) => {
			for (const entry of entries) await entry.open?.(opened);
		},
		agentEnded: async (conversation) => {
			for (const entry of entries) await entry.agentEnded?.({ conversation }).catch(warn);
		},
		busy: () => entries.some((entry) => entry.busy?.() === true),
		requests,
		labelChecks,
		versions,
		events,
		close,
	};
}

/**
 * Records `module` as the owner of `what key`, such as `serve the request type T`, in `owners`. Throws
 * `The entries <a> and <b> both <what> <key>` when another module owns it.
 */
function claim(owners: Map<string, string>, module: string, what: string, key: string): void {
	const owner = `${what} ${key}`;
	const other = owners.get(owner);

	if (other !== undefined) throw new Error(`The entries ${other} and ${module} both ${owner}`);

	owners.set(owner, module);
}

/** The catch-up hook `hook`, whose `run` throws `invalid result: <path> <message>` for an invalid part. */
function checkedHook(hook: CatchUpHook): CatchUpHook {
	return {
		kind: hook.kind,
		run: async (harness, seen) => {
			const part: unknown = await hook.run(harness, seen);

			if (!Value.Check(CatchUpPart, part)) {
				throw new Error(`invalid result: ${invalidReason(Value.Errors(CatchUpPart, part))}`);
			}

			return part;
		},
	};
}

/** Why a value does not match its schema: the path and the message of its first error in `errors`. */
function invalidReason([error]: readonly TLocalizedValidationError[]): string {
	return [error?.instancePath, error?.message].filter((part) => part).join(" ");
}

/**
 * Imports the entry `module`. Node does not strip types under `node_modules`, where Pi installs npm packages, so jiti
 * loads a TypeScript entry there.
 */
async function importEntry(module: string): Promise<{ default: (options: EntryOptions) => Entry | Promise<Entry> }> {
	if (module.endsWith(".ts") && module.split(sep).includes("node_modules")) {
		const { createJiti } = await import("jiti");

		return createJiti(import.meta.url).import(module);
	}

	return import(pathToFileURL(module).href);
}
