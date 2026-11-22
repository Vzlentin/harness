import type { JsonValue } from "@earendil-works/chord/json";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationView, TaskId, TaskOutcome, TaskState } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import {
	type AnswerAuthor,
	AnswerInputs,
	type Ask,
	askAnswerText,
	type AskList,
	type AskWrite,
	NoteId,
	withAskRef,
	withRoundFrame,
} from "./asks.ts";
import { ListRef, withListTarget, withTarget } from "./target.ts";
import { type ClassifyReply, Todo, type TodoList, TodoState } from "./todo.ts";
import type { TreeReply } from "./tree.ts";
import { TYPED_KIND } from "./typed.ts";
import type { ViewChange } from "./view-change.ts";
import { Label, SpawnServes } from "./worker-labels.ts";

/**
 * The version of the protocol between the CLI and the host. A client refuses a host with another version, and the host
 * refuses the `hello` of a client with another version, unless the `hello` has `external: true`.
 */
export const PROTOCOL_VERSION = 43;

/** The error of each open request of a host that stops. */
export const HOST_CLOSING = "The host is closing";

/**
 * pi-ai's thinking levels, in its order. pi-ai exports them only from a module that the protocol must not load at run
 * time, so this is a copy, and a test checks it against pi-ai's `MODEL_THINKING_LEVELS`.
 */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];

/** One of pi-ai's thinking levels. */
export const ThinkingLevel = Type.Enum(THINKING_LEVELS);

/** Whether `value` is one of pi-ai's thinking levels. */
export function isThinkingLevel(value: string): value is ModelThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}

/** How long the host waits for the lock of `durable.sqlite`, which a client such as the workflows CLI can hold. */
export const STORE_LOCK_WAIT_MS = 60_000;

/**
 * The error of a client of protocol `client` and a host (process `pid`) of protocol `host`, which differ. A stopped host
 * restarts from the installed code, so the side that is older must catch up.
 */
export function versionMismatch(client: number, host: number, pid: number): string {
	return host > client
		? `This client uses harness protocol ${client} and the host (pid ${pid}) uses ${host}. Reload Pi with /reload, or use the harness CLI of the host's install`
		: `The harness host (pid ${pid}) uses protocol ${host}, not ${client}. The host is older: stop it with kill ${pid} and run the command again`;
}

/** The states of a child, as the host reports them. */
export const CHILD_STATES = ["busy", "idle", "error", "ended"] as const;

export type ChildState = (typeof CHILD_STATES)[number];

/**
 * One child as the host reports it. Provider, model and thinking level come from the child's agent. For a `{ conversation }`
 * target, `handle` and `conversation` are the conversation ID, and `name` is the child's lineage key.
 */
export type ChildInfo = {
	readonly handle: string;
	readonly conversation?: string;
	readonly name?: string;
	readonly state: ChildState;
	readonly provider: string;
	readonly model: string;
	readonly thinking: ModelThinkingLevel;
	/** The child's working directory. */
	readonly cwd: string;
	/** The labels of the child, when it has one. A conversation of the children library with no record has none. */
	readonly labels?: string[];
	/** The result references that `report` stored for the child, in the order of their first report. */
	readonly refs?: string[];
};

/** A task that `start` created, by its client key. `outcome` is there only when the task is terminal. */
export type TaskInfo = {
	readonly key: string;
	readonly id: TaskId<JsonValue>;
	/** The name of the task definition. */
	readonly kind: string;
	/**
	 * The version on the task's record: the version of the definition that last ran or migrated it, so a client can tell
	 * which version of an entry the host used for this task. A task that no loaded definition can run keeps its version.
	 */
	readonly version: number;
	readonly status: TaskState<JsonValue, JsonValue>["status"];
	readonly outcome?: TaskOutcome<JsonValue>;
	/** The result references that `report` stored for the task, in the order of their first report. */
	readonly refs?: string[];
};

/** The fields of a `report` line, before its worker. */
const ReportFields = {
	type: Type.Literal("report"),
	caller: Type.String(),
	refs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
};

/** The absent key of a `report` line, which refuses the other worker key. */
const absent = Type.Optional(Type.Never());

/** The prototypes of a plain object, which JSON gives and the store takes. */
const PLAIN_PROTOTYPES: readonly unknown[] = [Object.prototype, null];

/**
 * A JSON value: null, a boolean, a finite number, a string, or an array or a plain object of JSON values. A value with
 * `undefined`, a function or a class instance in it is not JSON. A request line is JSON, so `start` takes any input,
 * and the host checks with it the values that entries give for the store.
 */
export const Json = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Refine(
				Type.Record(Type.String(), Type.Ref("Json")),
				(value) => PLAIN_PROTOTYPES.includes(Object.getPrototypeOf(value)),
				() => "must be a plain object",
			),
		]),
	},
	"Json",
);

/**
 * One request line of a type that the host owns, as the host checks it. The caller is `PI_SESSION_ID`, or `cli`
 * without one. Unknown extra keys are allowed.
 */
export const RequestLine = Type.Union([
	Type.Object({
		type: Type.Literal("hello"),
		version: Type.Number(),
		/** Whether the client is not a harness client and checks the version of the host itself. */
		external: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		type: Type.Literal("spawn"),
		requestId: Type.String(),
		caller: Type.String(),
		/** Whether the host pushes the answers of this request to the caller. */
		notify: Type.Boolean(),
		name: Type.Optional(Type.String()),
		/**
		 * The provider and the model that the caller asks for. Without both, the host takes `subagentModel` from Pi's global
		 * settings, else the caller's. With only one, the other is the caller's.
		 */
		provider: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		/** The level the caller asks for. The host refuses a level that the model does not have. */
		thinking: Type.Optional(ThinkingLevel),
		/** The caller's own provider and model, used when the request and the settings give none. */
		callerProvider: Type.Optional(Type.String()),
		callerModel: Type.Optional(Type.String()),
		/**
		 * The caller's own level, used without `thinking` and without `subagentThinkingLevel` in Pi's global settings,
		 * clamped to the nearest level that the model has.
		 */
		callerThinking: Type.String(),
		cwd: Type.String({ minLength: 1 }),
		tools: Type.Optional(Type.Immutable(Type.Array(Type.String()))),
		prompt: Type.String(),
		/** What the child serves, which gives it the label `parley:<slug>` or `item:<id>`. */
		serves: Type.Optional(SpawnServes),
		/** The labels of the child, which the entry of each label kind checks before the spawn. */
		labels: Type.Optional(Type.Array(Label)),
	}),
	Type.Object({
		type: Type.Literal("send"),
		requestId: Type.String(),
		caller: Type.String(),
		handle: Type.String(),
		message: Type.String(),
		followUp: Type.Boolean(),
		/** As for `spawn`. */
		notify: Type.Boolean(),
	}),
	Type.Object({ type: Type.Literal("wait"), handle: Type.String(), timeout: Type.Number() }),
	Type.Object({ type: Type.Literal("status"), handle: Type.String() }),
	Type.Object({ type: Type.Literal("list"), caller: Type.String() }),
	/** The handle of `caller` when it is a child of this host by handle, or `agent` when it is the project agent. */
	Type.Object({ type: Type.Literal("whoami"), caller: Type.String() }),
	/**
	 * Waits until the host has answers of the children of `caller`, or answers of the user to its asks, to push, and
	 * replies with them. The answers of the children then become read, and the answers of the user leave the queue. A
	 * newer request of the same caller replaces this one, which then gets no reply. It needs a connection.
	 */
	Type.Object({ type: Type.Literal("answers"), caller: Type.String() }),
	Type.Object({ type: Type.Literal("rename"), caller: Type.String(), handle: Type.String(), name: Type.String() }),
	/**
	 * Ends the child of the target and the children it spawned. The records stay, so a `send` resumes a child. The caller
	 * `cli` can stop any child; another caller only its own children. For `cli`, a stop of the project agent or of a
	 * conversation with no record aborts its turn, and the conversation stays.
	 */
	...withTarget({ type: Type.Literal("stop"), caller: Type.String() }),
	/**
	 * The stream of the child for a mirror session of the Pi extension: the reply, then one `{ event: WatchLine }` line
	 * after each commit to the child's conversation and after each rename. Every other line on the connection stays a
	 * reply, in request order. A connection carries one watch.
	 */
	...withTarget({ type: Type.Literal("watch") }),
	/** Stops the child's current turn. A mirror session sends it. */
	...withTarget({ type: Type.Literal("abort") }),
	/**
	 * Asks a model of Pi's settings `question` about the conversation of the target, and replies with its answer. The model
	 * reads the messages of the user, the text of the assistant and the tool calls, at most `MAX_QUERY` of the last part.
	 * It writes nothing and starts no turn. The caller `cli` can query any target; another caller only its own children.
	 */
	...withTarget({ type: Type.Literal("query"), caller: Type.String(), question: Type.String({ minLength: 1 }) }),
	/**
	 * A mirror session's change of the child's model or thinking level. It has no caller, and it takes a handle, not a
	 * conversation. A new model keeps the thinking level when the model has it, and takes the nearest level that it has
	 * otherwise. The host refuses a level that the model does not have.
	 */
	Type.Object({
		type: Type.Literal("configure"),
		handle: Type.String(),
		conversation: Type.Optional(Type.Never()),
		provider: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		/** The level the caller asks for. The host refuses a level that the model does not have. */
		thinking: Type.Optional(ThinkingLevel),
	}),
	/** A mirror session's message to the child. It has no caller. A conversation takes it only while it works, as a steer. */
	...withTarget({
		type: Type.Literal("input"),
		requestId: Type.String(),
		message: Type.String(),
		followUp: Type.Boolean(),
	}),
	/**
	 * A passive message for the conversation's transcript: a user message of the entry kind `kind` (default
	 * `harness.note`), with `data`. It starts no turn. An idle conversation places it at once, and a busy one at its next
	 * boundary, so the model reads it on its next request. The request ID is in the scope `note:`, and a repeated one adds
	 * nothing. A kind that starts with `pi.` is refused, because pi-durable does not check the kind of a write. The kind
	 * `harness.typed` is refused too: only an `input` gives it.
	 */
	...withTarget({
		type: Type.Literal("note"),
		requestId: Type.String(),
		text: Type.String(),
		kind: Type.Optional(Type.String({ minLength: 1, pattern: `^(?!pi\\.|${TYPED_KIND.replaceAll(".", "\\.")}$)` })),
		data: Type.Optional(Json),
	}),
	/**
	 * Starts a background task of the kind `kind`, a task of an entry in `entries.json`, in the root conversation.
	 * A repeated `key` gives the first task, and its new kind, version, input and labels are ignored. The task has the
	 * labels of `labels`, and the label of `input.serves` when the input has a `serves` of a spawn. With `version`, a host
	 * whose definition of `kind` has another version refuses before it creates anything.
	 */
	Type.Object({
		type: Type.Literal("start"),
		kind: Type.String(),
		input: Json,
		key: Type.String(),
		version: Type.Optional(Type.Number()),
		/** The labels of the task, which the entry of each label kind checks before a first start. */
		labels: Type.Optional(Type.Array(Label)),
	}),
	Type.Object({ type: Type.Literal("task"), key: Type.String() }),
	/** Waits until the task is terminal, and replies with its outcome. A client polls `task` for the status. */
	Type.Object({ type: Type.Literal("wait-task"), key: Type.String() }),
	/** Aborts the task and the work that it owns. */
	Type.Object({ type: Type.Literal("abort-task"), key: Type.String() }),
	/**
	 * Stores the result references `refs` of a worker, each once, and replies with all the references of the worker. The
	 * worker is the child `handle`, the started task `key`, or, with neither, the child whose conversation is the caller.
	 * After the commit, the `reported` handlers of the entries run, and the reply waits for them.
	 */
	Type.Object({ ...ReportFields, handle: Type.String(), key: absent }),
	Type.Object({ ...ReportFields, key: Type.String(), handle: absent }),
	Type.Object({ ...ReportFields, handle: absent, key: absent }),
	/**
	 * Adds a todo with the state `open` to a list, and replies with it. The list is the one of a handle, a conversation or
	 * the task of a `start` key, or, with none of them, the caller's own list.
	 */
	...withListTarget({
		type: Type.Literal("todo"),
		caller: Type.String(),
		action: Type.Literal("add"),
		text: Type.String(),
	}),
	/**
	 * Sets the state of the todo `id`, and its text with `text`, and replies with the todo. It comes before `list`, so a
	 * `set` with a bad state fails on `state`, not on `action`.
	 */
	...withListTarget({
		type: Type.Literal("todo"),
		caller: Type.String(),
		action: Type.Literal("set"),
		id: Todo.properties.id,
		state: TodoState,
		text: Type.Optional(Type.String()),
	}),
	/** Replies with the list, in ID order. */
	...withListTarget({ type: Type.Literal("todo"), caller: Type.String(), action: Type.Literal("list") }),
	/**
	 * Writes a round of asks, with the caller as their asker, and replies with the write. With `parley`, the asks serve
	 * the parley of its slug, and with `item`, which needs `parley`, the parley shapes that work item. A round with
	 * `parley`, and a ref by `slug` and `n` in the requests below, need an entry that serves the `ask` requests, such as
	 * the projects entry: without one, they fail with `no loaded entry serves parley asks`.
	 */
	...withRoundFrame({ type: Type.Literal("ask"), action: Type.Literal("round"), caller: Type.String() }),
	/**
	 * Writes the answers of asks in one write, and replies with the write. Each answer names its ask by `id`, or by `slug`
	 * and `n`. The answer `ok` to the read-back of a parley makes it a contract. `user` marks answers that the user gave;
	 * without it, the answers are those of the agent of the caller.
	 */
	Type.Object({
		type: Type.Literal("ask"),
		action: Type.Literal("answer"),
		caller: Type.String(),
		answers: AnswerInputs,
		user: Type.Optional(Type.Literal(true)),
	}),
	/** Drops the open ask of `id`, or of `slug` and `n`, and replies with the write. */
	...withAskRef({ type: Type.Literal("ask"), action: Type.Literal("drop"), caller: Type.String() }),
	/**
	 * Sets `note`, the ID of the note in the vault, on the ask of `id`, or of `slug` and `n`, in any state, and replies
	 * with the ask. Only the asker of the ask sends it. A second note replaces the first.
	 */
	...withAskRef({ type: Type.Literal("ask"), action: Type.Literal("note"), caller: Type.String(), note: NoteId }),
	/** Replies with the ask of `id`, or of `slug` and `n`, in any state. */
	...withAskRef({ type: Type.Literal("ask"), action: Type.Literal("read") }),
	/** Replies with the open asks, in ID order. */
	Type.Object({ type: Type.Literal("ask"), action: Type.Literal("list") }),
	/**
	 * Replies with the nodes of the project: the project agent, the children by handle, and the started tasks with their
	 * child tasks and the conversations of the children library that the tasks own.
	 */
	Type.Object({ type: Type.Literal("tree") }),
	/**
	 * The reply of `tree`, then one `{ event: TreeEvent }` line for the nodes that a later commit changed, and one for
	 * the nodes that went. It needs a connection.
	 */
	Type.Object({ type: Type.Literal("watch-tree") }),
	/**
	 * Asks the classifier of Pi's settings about the todos `ids` that are open, default every open todo, of the list
	 * `list`. Without `list`, it asks about the list that an entry gives, such as the work items of the projects entry,
	 * with `ids` as the IDs of that list. It stores nothing.
	 */
	Type.Object({
		type: Type.Literal("classify-todos"),
		list: Type.Optional(ListRef),
		ids: Type.Optional(Type.Array(Todo.properties.id)),
	}),
]);

export type Request = Static<typeof RequestLine>;

/** A request line of a type that an entry serves: its type, and its other fields as JSON. */
export type EntryRequestLine = Readonly<Record<string, JsonValue>> & { readonly type: string };

/** An `ask` request. */
export type AskRequest = Extract<Request, { type: "ask" }>;

/** The author of the answers of the `ask answer` request `request`, as the host works it out. */
export type AnswerAuthorOf = (request: Extract<AskRequest, { action: "answer" }>) => Promise<AnswerAuthor>;

/** The value of the reply to each request type. */
export type Replies = {
	/** `entries` has the version of the protocol of each entry that gives one, by its name. */
	readonly hello: {
		readonly version: number;
		readonly pid: number;
		readonly entries: Readonly<Record<string, number>>;
	};
	readonly spawn: ChildInfo;
	readonly send: { readonly verb: string; readonly child: ChildInfo };
	readonly wait: { readonly answer: string };
	readonly status: ChildInfo;
	readonly list: readonly ChildInfo[];
	readonly whoami: { readonly handle?: string };
	readonly answers: readonly Delivery[];
	readonly rename: ChildInfo;
	readonly stop: { readonly handle: string; readonly name?: string };
	readonly watch: { readonly view: ConversationView; readonly child: ChildInfo };
	readonly abort: ChildInfo;
	readonly query: { readonly answer: string };
	readonly input: Replies["send"];
	readonly note: { readonly child: ChildInfo };
	readonly configure: ChildInfo;
	readonly start: TaskInfo;
	readonly task: TaskInfo;
	readonly "wait-task": TaskInfo;
	readonly "abort-task": TaskInfo;
	/** All the references of the worker, in the order of their first report. */
	readonly report: { readonly refs: readonly string[] };
	/** The todo of `add` and `set`, or the list of `list`. */
	readonly todo: Todo | TodoList;
	readonly tree: TreeReply;
	readonly "watch-tree": TreeReply;
	readonly "classify-todos": ClassifyReply;
	/** The write of `round`, `answer` and `drop`, the ask of `read`, or the open asks of `list`. */
	readonly ask: AskWrite | Ask | AskList;
};

/**
 * An event of a watch after its reply, sent as `{ event: WatchLine }`: the change of one commit, or an empty change
 * after a rename, an end or a resume.
 */
export type WatchLine = { readonly change: ViewChange; readonly child: ChildInfo };

/**
 * The answers of the user that the host pushes to the asker. For the ask `ask` with no parley: the line and the words
 * of the ask. For the asks `asks` of the parley `parley`: the text of the parley.
 */
export type UserDelivery =
	| { readonly source: "ask"; readonly ask: number; readonly text: string }
	| { readonly source: "parley"; readonly parley: string; readonly asks: number[]; readonly text: string };

/** One delivery of answers to `asker`: the IDs of the answered asks that it gives, and the delivery. */
export type AnswerGroup = { readonly asker: string; readonly asks: readonly number[]; readonly delivery: UserDelivery };

/**
 * The deliveries of the answered asks `answered`, which all have an asker other than the caller of the answer, in the
 * order of `answered`. Each ask is in one delivery.
 */
export type GroupAnswers = (answered: readonly Ask[]) => AnswerGroup[];

/** The delivery of the answered ask `ask` alone, to its asker. */
export function askGroup(ask: Ask): AnswerGroup {
	return { asker: ask.asker, asks: [ask.id], delivery: { source: "ask", ask: ask.id, text: askAnswerText(ask) } };
}

/**
 * What the host pushes to a caller: the answers of a child, as `wait` gives them, or its error when `failed`, the
 * answers of the user to the asks of the caller, or the text of a delivery of an entry, with its key.
 */
export type Delivery =
	| {
			readonly source: "child";
			readonly handle: string;
			readonly name?: string;
			readonly text: string;
			readonly failed: boolean;
	  }
	| UserDelivery
	| { readonly source: "entry"; readonly key: string; readonly text: string };

/** One reply line. */
export type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** The message of a thrown value. */
export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
