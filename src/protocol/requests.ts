import type { JsonValue } from "@earendil-works/chord/json";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationView, TaskId, TaskOutcome, TaskState } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import {
	type Message,
	MessageLog,
	Part,
	PartAdd,
	PartFilter,
	type PartList,
	type Person,
	PersonAdd,
	type PersonList,
	type Rule,
	RuleEdit,
	RuleFilter,
	type RuleList,
	RuleNew,
	type Term,
	TermEdit,
	type TermList,
	TermNew,
	Thread,
	ThreadAdd,
	type ThreadList,
	type ThreadMessages,
} from "./project.ts";
import { ListRef, withListTarget, withTarget } from "./target.ts";
import { type ClassifyReply, Todo, type TodoList, TodoState } from "./todo.ts";
import type { TreeReply } from "./tree.ts";
import type { ViewChange } from "./view-change.ts";

/**
 * The version of the protocol between the CLI and the host. A client refuses a host with another version, and the host
 * refuses the `hello` of a client with another version.
 */
export const PROTOCOL_VERSION = 18;

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

/**
 * The marker of a child that a kernel spawned through `rlm`. The host keeps it on the child's record, and gives it in the
 * child's info.
 */
export const ChildKind = Type.Literal("rlm");

export type ChildKind = Static<typeof ChildKind>;

/** The states of a child, as the host reports them. */
export const CHILD_STATES = ["busy", "idle", "error", "closed"] as const;

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
	/** The marker of a child by handle that a kernel spawned through `rlm`. The other targets have none. */
	readonly kind?: ChildKind;
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
};

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
 * One request line, as the host checks it. The caller is `PI_SESSION_ID`, or `cli` without one. Unknown extra keys are
 * allowed.
 */
export const RequestLine = Type.Union([
	Type.Object({ type: Type.Literal("hello"), version: Type.Number() }),
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
		kind: Type.Optional(ChildKind),
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
	 * Waits until the host has answers of the children of `caller` to push, marks them read and replies with them. A
	 * newer request of the same caller replaces this one, which then gets no reply. It needs a connection.
	 */
	Type.Object({ type: Type.Literal("answers"), caller: Type.String() }),
	Type.Object({ type: Type.Literal("rename"), caller: Type.String(), handle: Type.String(), name: Type.String() }),
	Type.Object({ type: Type.Literal("stop"), caller: Type.String(), handle: Type.String() }),
	/**
	 * The stream of the child for a mirror session of the Pi extension: the reply, then one `{ event: WatchLine }` line
	 * after each commit to the child's conversation and after each rename. Every other line on the connection stays a
	 * reply, in request order. A connection carries one watch.
	 */
	...withTarget({ type: Type.Literal("watch") }),
	/** Stops the child's current turn. A mirror session sends it. */
	...withTarget({ type: Type.Literal("abort") }),
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
	 * nothing. A kind that starts with `pi.` is refused, because pi-durable does not check the kind of a write.
	 */
	...withTarget({
		type: Type.Literal("note"),
		requestId: Type.String(),
		text: Type.String(),
		kind: Type.Optional(Type.String({ minLength: 1, pattern: "^(?!pi\\.)" })),
		data: Type.Optional(Json),
	}),
	/**
	 * Starts a background task of the kind `kind`, a task of an entry in `entries.json`, in the root conversation.
	 * A repeated `key` gives the first task, and its new kind, version and input are ignored. With `version`, a host
	 * whose definition of `kind` has another version refuses before it creates anything.
	 */
	Type.Object({
		type: Type.Literal("start"),
		kind: Type.String(),
		input: Json,
		key: Type.String(),
		version: Type.Optional(Type.Number()),
	}),
	Type.Object({ type: Type.Literal("task"), key: Type.String() }),
	/** Waits until the task is terminal, and replies with its outcome. A client polls `task` for the status. */
	Type.Object({ type: Type.Literal("wait-task"), key: Type.String() }),
	/** Aborts the task and the work that it owns. */
	Type.Object({ type: Type.Literal("abort-task"), key: Type.String() }),
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
	/** Adds a person, and replies with it. */
	Type.Object({ type: Type.Literal("person"), action: Type.Literal("add"), ...PersonAdd.properties }),
	/** Replies with the persons, in ID order. */
	Type.Object({ type: Type.Literal("person"), action: Type.Literal("list") }),
	/** Adds a thread with one or more persons, in a new ownerless conversation, and replies with it. */
	Type.Object({ type: Type.Literal("thread"), action: Type.Literal("add"), ...ThreadAdd.properties }),
	/** Replies with the threads, in ID order. */
	Type.Object({ type: Type.Literal("thread"), action: Type.Literal("list") }),
	/** Replies with the thread `id` and its messages, oldest first. */
	Type.Object({ type: Type.Literal("thread"), action: Type.Literal("read"), id: Thread.properties.id }),
	/** Adds a message to a thread, and replies with it. The host sets its state from its direction. */
	Type.Object({
		type: Type.Literal("message"),
		action: Type.Literal("log"),
		caller: Type.String(),
		...MessageLog.properties,
	}),
	/** Adds a rule, which retires the rule `replaces`, and replies with it. */
	Type.Object({
		type: Type.Literal("rule"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...RuleNew.properties,
	}),
	/**
	 * Changes the rule `id`, and replies with it. It comes after the new rule, so a new rule without `source` fails on
	 * `source`. The host refuses a change with `replaces`.
	 */
	Type.Object({
		type: Type.Literal("rule"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...RuleEdit.properties,
	}),
	/** Replies with the rules, in ID order: with `kind` or `status`, only those that have it. */
	Type.Object({ type: Type.Literal("rule"), action: Type.Literal("list"), ...RuleFilter.properties }),
	/** Adds a term, and replies with it. */
	Type.Object({
		type: Type.Literal("term"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...TermNew.properties,
	}),
	/** Changes the term `id`, and replies with it. */
	Type.Object({
		type: Type.Literal("term"),
		action: Type.Literal("set"),
		caller: Type.String(),
		...TermEdit.properties,
	}),
	/** Replies with the terms, in ID order. */
	Type.Object({ type: Type.Literal("term"), action: Type.Literal("list") }),
	/** Adds a part that explains rules and terms, and replies with it. */
	Type.Object({
		type: Type.Literal("part"),
		action: Type.Literal("add"),
		caller: Type.String(),
		...PartAdd.properties,
	}),
	/** Marks the part `id` checked now and not stale, and replies with it. */
	Type.Object({
		type: Type.Literal("part"),
		action: Type.Literal("check"),
		caller: Type.String(),
		id: Part.properties.id,
	}),
	/** Replies with the parts, in ID order: with `rule` or `term`, only those that explain it. */
	Type.Object({ type: Type.Literal("part"), action: Type.Literal("list"), ...PartFilter.properties }),
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
	 * `list`, default the list of the project. It stores nothing.
	 */
	Type.Object({
		type: Type.Literal("classify-todos"),
		list: Type.Optional(ListRef),
		ids: Type.Optional(Type.Array(Todo.properties.id)),
	}),
]);

export type Request = Static<typeof RequestLine>;

/** The value of the reply to each request type. */
export type Replies = {
	readonly hello: { readonly version: number; readonly pid: number };
	readonly spawn: ChildInfo;
	readonly send: { readonly verb: string; readonly child: ChildInfo };
	readonly wait: { readonly answer: string };
	readonly status: ChildInfo;
	readonly list: readonly ChildInfo[];
	readonly whoami: { readonly handle: string };
	readonly answers: readonly Delivery[];
	readonly rename: ChildInfo;
	readonly stop: { readonly handle: string; readonly name?: string };
	readonly watch: { readonly view: ConversationView; readonly child: ChildInfo };
	readonly abort: ChildInfo;
	readonly input: Replies["send"];
	readonly note: { readonly child: ChildInfo };
	readonly configure: ChildInfo;
	readonly start: TaskInfo;
	readonly task: TaskInfo;
	readonly "wait-task": TaskInfo;
	readonly "abort-task": TaskInfo;
	/** The todo of `add` and `set`, or the list of `list`. */
	readonly todo: Todo | TodoList;
	readonly tree: TreeReply;
	readonly "watch-tree": TreeReply;
	readonly "classify-todos": ClassifyReply;
	/** The person of `add`, or the persons of `list`. */
	readonly person: Person | PersonList;
	/** The thread of `add`, the threads of `list`, or the thread and its messages of `read`. */
	readonly thread: Thread | ThreadList | ThreadMessages;
	readonly message: Message;
	/** The rule of `set`, or the rules of `list`. */
	readonly rule: Rule | RuleList;
	/** The term of `set`, or the terms of `list`. */
	readonly term: Term | TermList;
	/** The part of `add` and `check`, or the parts of `list`. */
	readonly part: Part | PartList;
};

/**
 * An event of a watch after its reply, sent as `{ event: WatchLine }`: the change of one commit, an empty change after a
 * rename, or the end when the child was stopped.
 */
export type WatchLine =
	| { readonly change: ViewChange; readonly child: ChildInfo; readonly stopped?: undefined }
	| { readonly stopped: true };

/**
 * The answers of one child that the host pushes to its caller: the answers that `wait` gives, or its error when
 * `failed`.
 */
export type Delivery = {
	readonly handle: string;
	readonly name?: string;
	readonly text: string;
	readonly failed: boolean;
};

/** One reply line. */
export type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** The message of a thrown value. */
export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
