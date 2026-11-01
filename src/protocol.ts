import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationView, TaskId, TaskOutcome, TaskState } from "@earendil-works/pi-durable";
import { type Static, type TProperties, Type } from "typebox";
import type { ViewChange } from "./view-change.ts";

/**
 * The version of the protocol between the CLI and the host. A client refuses a host with another version, and the host
 * refuses the `hello` of a client with another version.
 */
export const PROTOCOL_VERSION = 11;

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
 * The handle of the project agent, the host's root conversation, in `watch`, `input`, `note`, `abort` and `configure`. It
 * is not hex, so no child has it.
 */
export const AGENT_HANDLE = "agent";

export type ChildState = "busy" | "idle" | "error";

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

/** Any JSON value. A request line is JSON, so `start` takes any input. */
export const Json = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Record(Type.String(), Type.Ref("Json")),
		]),
	},
	"Json",
);

/**
 * The target of `watch`, `input` and `abort`: a handle, or the ID of a conversation that the children library opened,
 * such as a child of a task.
 */
export type Target =
	| { readonly handle: string; readonly conversation?: never }
	| { readonly conversation: string; readonly handle?: never };

/** One request line. The caller is `PI_SESSION_ID`, or `cli` without one. */
export type Request =
	| { readonly type: "hello"; readonly version: number }
	| {
			readonly type: "spawn";
			readonly requestId: string;
			readonly caller: string;
			/** Whether the host pushes the answers of this request to the caller. */
			readonly notify: boolean;
			readonly name?: string;
			readonly provider: string;
			readonly model: string;
			/** The level the caller asks for; the host refuses it when the model does not have it. */
			readonly thinking?: string;
			/** The caller's own level, used without `thinking`, clamped to the nearest level that the model has. */
			readonly callerThinking: string;
			readonly cwd: string;
			readonly tools?: readonly string[];
			readonly prompt: string;
	  }
	| {
			readonly type: "send";
			readonly requestId: string;
			readonly caller: string;
			readonly handle: string;
			readonly message: string;
			readonly followUp: boolean;
			/** As for `spawn`. */
			readonly notify: boolean;
	  }
	| { readonly type: "wait"; readonly handle: string; readonly timeout: number }
	| { readonly type: "status"; readonly handle: string }
	| { readonly type: "list"; readonly caller: string }
	/**
	 * Waits until the host has answers of the children of `caller` to push, marks them read and replies with them. A
	 * newer request of the same caller replaces this one, which then gets no reply. It needs a connection.
	 */
	| { readonly type: "answers"; readonly caller: string }
	| { readonly type: "rename"; readonly caller: string; readonly handle: string; readonly name: string }
	| { readonly type: "stop"; readonly caller: string; readonly handle: string }
	/**
	 * The stream of the child for a mirror session of the Pi extension: the reply, then one `{ event: WatchLine }` line
	 * after each commit to the child's conversation and after each rename. Every other line on the connection stays a
	 * reply, in request order. A connection carries one watch.
	 */
	| ({ readonly type: "watch" } & Target)
	/** Stops the child's current turn. A mirror session sends it. */
	| ({ readonly type: "abort" } & Target)
	/**
	 * A mirror session's change of the child's model or thinking level. It has no caller. A new model keeps the thinking level
	 * when the model has it, and takes the nearest level that it has otherwise. The host refuses a level that the model
	 * does not have.
	 */
	| {
			readonly type: "configure";
			readonly handle: string;
			readonly provider?: string;
			readonly model?: string;
			readonly thinking?: ModelThinkingLevel;
	  }
	/** A mirror session's message to the child. It has no caller. A conversation takes it only while it works, as a steer. */
	| ({
			readonly type: "input";
			readonly requestId: string;
			readonly message: string;
			readonly followUp: boolean;
	  } & Target)
	/**
	 * A passive message for the conversation's transcript: a user message of the entry kind `kind` (default
	 * `harness.note`), with `data`. It starts no turn. An idle conversation places it at once, and a busy one at its next
	 * boundary, so the model reads it on its next request. The request ID is in the scope `note:`, and a repeated one adds
	 * nothing. A kind that starts with `pi.` is refused.
	 */
	| ({
			readonly type: "note";
			readonly requestId: string;
			readonly text: string;
			readonly kind?: string;
			readonly data?: JsonValue;
	  } & Target)
	/**
	 * Starts a background task of the kind `kind`, a task of an entry in `entries.json`, in the root conversation.
	 * A repeated `key` gives the first task, and its new kind, version and input are ignored. With `version`, a host
	 * whose definition of `kind` has another version refuses before it creates anything.
	 */
	| {
			readonly type: "start";
			readonly kind: string;
			readonly input: JsonValue;
			readonly key: string;
			readonly version?: number;
	  }
	| { readonly type: "task"; readonly key: string }
	/** Waits until the task is terminal, and replies with its outcome. A client polls `task` for the status. */
	| { readonly type: "wait-task"; readonly key: string }
	/** Aborts the task and the work that it owns. */
	| { readonly type: "abort-task"; readonly key: string };

/**
 * The request objects of `type` with `fields` and a target: one with `handle`, one with `conversation`. Each refuses the
 * other key, because an object schema accepts extra keys.
 */
function targeted<T extends string, F extends TProperties>(type: T, fields: F) {
	return Type.Union([
		Type.Object({
			...fields,
			type: Type.Literal(type),
			handle: Type.String(),
			conversation: Type.Optional(Type.Never()),
		}),
		Type.Object({
			...fields,
			type: Type.Literal(type),
			conversation: Type.String(),
			handle: Type.Optional(Type.Never()),
		}),
	]);
}

/**
 * The check of a request line on the host. It is looser than `Request`, so the host answers a spawn without `cwd` and an
 * unknown thinking level with its own errors.
 */
export const RequestLine = Type.Union([
	Type.Object({ type: Type.Literal("hello"), version: Type.Number() }),
	Type.Object({
		type: Type.Literal("spawn"),
		requestId: Type.String(),
		caller: Type.String(),
		notify: Type.Boolean(),
		name: Type.Optional(Type.String()),
		provider: Type.String(),
		model: Type.String(),
		thinking: Type.Optional(Type.String()),
		callerThinking: Type.String(),
		cwd: Type.Optional(Type.String()),
		tools: Type.Optional(Type.Immutable(Type.Array(Type.String()))),
		prompt: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("send"),
		requestId: Type.String(),
		caller: Type.String(),
		handle: Type.String(),
		message: Type.String(),
		followUp: Type.Boolean(),
		notify: Type.Boolean(),
	}),
	Type.Object({ type: Type.Literal("wait"), handle: Type.String(), timeout: Type.Number() }),
	Type.Object({ type: Type.Literal("status"), handle: Type.String() }),
	Type.Object({ type: Type.Literal("list"), caller: Type.String() }),
	Type.Object({ type: Type.Literal("answers"), caller: Type.String() }),
	Type.Object({ type: Type.Literal("rename"), caller: Type.String(), handle: Type.String(), name: Type.String() }),
	Type.Object({ type: Type.Literal("stop"), caller: Type.String(), handle: Type.String() }),
	targeted("watch", {}),
	targeted("abort", {}),
	Type.Object({
		type: Type.Literal("configure"),
		handle: Type.String(),
		provider: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
	}),
	targeted("input", { requestId: Type.String(), message: Type.String(), followUp: Type.Boolean() }),
	targeted("note", {
		requestId: Type.String(),
		text: Type.String(),
		kind: Type.Optional(Type.String({ minLength: 1 })),
		data: Type.Optional(Json),
	}),
	Type.Object({
		type: Type.Literal("start"),
		kind: Type.String(),
		input: Json,
		key: Type.String(),
		version: Type.Optional(Type.Number()),
	}),
	Type.Object({ type: Type.Literal("task"), key: Type.String() }),
	Type.Object({ type: Type.Literal("wait-task"), key: Type.String() }),
	Type.Object({ type: Type.Literal("abort-task"), key: Type.String() }),
]);

export type RequestLine = Static<typeof RequestLine>;

/** The value of the reply to each request type. */
export type Replies = {
	readonly hello: { readonly version: number; readonly pid: number };
	readonly spawn: ChildInfo;
	readonly send: { readonly verb: string; readonly child: ChildInfo };
	readonly wait: { readonly answer: string };
	readonly status: ChildInfo;
	readonly list: readonly ChildInfo[];
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

/** The text of the message that brings `delivery` to its caller. */
export function deliveryText(delivery: Delivery): string {
	return `subagent ${runDisplayName(delivery)} ${delivery.failed ? "failed" : "finished"}\n\n${delivery.text}`;
}

/** One reply line. */
export type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** The files of the host of `project`: `$XDG_STATE_HOME/harness/<project>/`, default `~/.local/state/harness/<project>/`. */
/**
 * The CLI of this install, which the host start and the Herdr tabs run with this Node: `cli.js` next to the built
 * modules, or `cli.ts` in a checkout, which Node runs with type stripping.
 */
export function cliPath(): string {
	return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url));
}

export type StatePaths = { dir: string; socket: string; log: string };

export function statePaths(project: string): StatePaths {
	const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harness", project);

	return { dir, socket: join(dir, "host.sock"), log: join(dir, "host.log") };
}

export function isValidRunName(value: string): boolean {
	return (
		value.length > 0 && value.length <= 64 && value.trim() === value && !Array.from(value).some(isControlCharacter)
	);
}

/** U+0000 to U+001F and U+007F. */
function isControlCharacter(character: string): boolean {
	const code = character.charCodeAt(0);

	return code <= 0x1f || code === 0x7f;
}

type Labeled = {
	readonly handle: string;
	readonly name?: string | undefined;
	readonly conversation?: string | undefined;
};

/** The label of a child: its name, or its handle when it has no name. */
export function childLabel(child: Labeled): string {
	return child.name ?? child.handle;
}

export function runDisplayName(metadata: { readonly handle: string; readonly name?: string | undefined }): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

/**
 * The title of a child in a client: `<name> (<handle>)`, or only the name for the project agent, which says what it is,
 * and for a conversation, whose name is its key.
 */
export function childTitle(child: Labeled): string {
	return child.handle === AGENT_HANDLE || child.conversation !== undefined ? childLabel(child) : runDisplayName(child);
}

/** The message of a thrown value. */
export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The line of one child in a list. */
export function childLine(child: ChildInfo): string {
	return `${runDisplayName(child)}  ${child.state.padEnd(8)}  ${child.provider}/${child.model}  ${child.thinking}`;
}

/** Calls `onLine` with each line that arrives on `socket`, without its newline. */
export function onLines(socket: Socket, onLine: (line: string) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;

		for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			onLine(line);
		}
	});
}
