import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationView, TaskId, TaskOutcome, TaskState } from "@earendil-works/pi-durable";

/** The version of the protocol between the CLI and the host. A client refuses a host with another version. */
export const PROTOCOL_VERSION = 7;

/**
 * The handle of the project agent, the host's root conversation, in `watch`, `input`, `abort` and `configure`. It is not
 * hex, so no child has it.
 */
export const AGENT_HANDLE = "agent";

export type ChildState = "busy" | "idle" | "error";

/** One child as the host reports it. Provider, model and thinking level come from the child's agent. */
export type ChildInfo = {
	readonly handle: string;
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

/** A model that the host can run, with what the viewer needs to show and change it. */
export type ModelInfo = {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	/** The thinking levels of the model, from `off`. */
	readonly thinkingLevels: readonly ModelThinkingLevel[];
};

/** One request line. The caller is `PI_SESSION_ID`, or `cli` without one. */
export type Request =
	| { readonly type: "hello"; readonly version: number }
	| {
			readonly type: "spawn";
			readonly requestId: string;
			readonly caller: string;
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
	  }
	| { readonly type: "wait"; readonly handle: string; readonly timeout: number }
	| { readonly type: "status"; readonly handle: string }
	| { readonly type: "list"; readonly caller: string }
	| { readonly type: "rename"; readonly caller: string; readonly handle: string; readonly name: string }
	| { readonly type: "stop"; readonly caller: string; readonly handle: string }
	/**
	 * The viewer's stream of the child: the reply, then one `{ event: WatchLine }` line after each commit to the child's
	 * conversation and after each rename. Every other line on the connection stays a reply, in request order. A
	 * connection carries one watch.
	 */
	| { readonly type: "watch"; readonly handle: string }
	/** Stops the child's current turn. The viewer sends it. */
	| { readonly type: "abort"; readonly handle: string }
	/** The models that have a login, for the viewer's model picker and context window. */
	| { readonly type: "models" }
	/**
	 * The viewer's change of the child's model or thinking level. It has no caller. A new model keeps the thinking level
	 * when the model has it, and takes the nearest level that it has otherwise.
	 */
	| {
			readonly type: "configure";
			readonly handle: string;
			readonly provider?: string;
			readonly model?: string;
			readonly thinking?: ModelThinkingLevel;
	  }
	/** The viewer's message to the child. It has no caller. */
	| {
			readonly type: "input";
			readonly requestId: string;
			readonly handle: string;
			readonly message: string;
			readonly followUp: boolean;
	  }
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

/** The value of the reply to each request type. */
export type Replies = {
	readonly hello: { readonly version: number; readonly pid: number };
	readonly spawn: ChildInfo;
	readonly send: { readonly verb: string; readonly child: ChildInfo };
	readonly wait: { readonly answer: string };
	readonly status: ChildInfo;
	readonly list: readonly ChildInfo[];
	readonly rename: ChildInfo;
	readonly stop: { readonly handle: string; readonly name?: string };
	readonly watch: { readonly view: ConversationView; readonly child: ChildInfo };
	readonly abort: ChildInfo;
	readonly input: Replies["send"];
	readonly models: readonly ModelInfo[];
	readonly configure: ChildInfo;
	readonly start: TaskInfo;
	readonly task: TaskInfo;
	readonly "wait-task": TaskInfo;
	readonly "abort-task": TaskInfo;
};

/**
 * An event of a watch after its reply, sent as `{ event: WatchLine }`: the changes of one commit or a rename, or the end
 * when the child was stopped.
 */
export type WatchLine =
	| { readonly ops: readonly Op[]; readonly child: ChildInfo; readonly stopped?: undefined }
	| { readonly stopped: true };

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

export function statePaths(project: string): { dir: string; socket: string; log: string } {
	const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harness", project);
	return { dir, socket: join(dir, "host.sock"), log: join(dir, "host.log") };
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: a name must not contain control characters.
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

/** The label of a child: its name, or its handle when it has no name. */
export function childLabel(child: { readonly handle: string; readonly name?: string | undefined }): string {
	return child.name ?? child.handle;
}

export function runDisplayName(metadata: { readonly handle: string; readonly name?: string | undefined }): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
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
