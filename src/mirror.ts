/**
 * A mirror session is a Pi session that shows a conversation of a harness host and sends what the user types to it.
 * The conversation stays in the host; the Pi session keeps only its target, in one custom entry. This module has no
 * runtime import of Pi, chord or pi-durable, so the Pi extension can load it.
 */
import { randomUUID } from "node:crypto";
import type { ConversationView } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type Client, connect, RETRY_DELAYS_MS, SHORT_CONNECTION_MS, tryEach } from "./client.ts";
import { AGENT_HANDLE, type ChildInfo, type Request, runDisplayName, type Target, type WatchLine } from "./protocol.ts";
import { applyChange } from "./view-change.ts";
import { inboxOf, withdrawnTexts } from "./view-state.ts";

/** The `customType` of the session entry that holds the target of a mirror session. */
export const MIRROR_ENTRY = "harness-mirror";

/**
 * The conversation that a mirror session shows, in the host of `project`: the child or project agent `handle`, or the
 * conversation `conversation` that the children library opened. Each refuses the other key.
 */
export const MirrorTarget = Type.Union([
	Type.Object({ project: Type.String(), handle: Type.String(), conversation: Type.Optional(Type.Never()) }),
	Type.Object({ project: Type.String(), conversation: Type.String(), handle: Type.Optional(Type.Never()) }),
]);

export type MirrorTarget = Static<typeof MirrorTarget>;

/** Whether the data of a session entry is a mirror target. */
export function isMirrorTarget(data: unknown): data is MirrorTarget {
	return Value.Check(MirrorTarget, data);
}

/**
 * The Pi flags that open a mirror session of a target: the project, and the child or the conversation in place of the
 * project agent.
 */
export const PI_FLAGS = { project: "harness", child: "harness-child", conversation: "harness-conversation" } as const;

/** The arguments of `pi` that open a mirror session of `target`. */
export function piArgs(target: MirrorTarget): string[] {
	const child =
		target.conversation !== undefined
			? [`--${PI_FLAGS.conversation}`, target.conversation]
			: target.handle === AGENT_HANDLE
				? []
				: [`--${PI_FLAGS.child}`, target.handle];

	return [`--${PI_FLAGS.project}`, target.project, ...child];
}

/**
 * The arguments of the `harness` CLI that open `target` in Pi: `<project>` for the project agent, `--project <project>
 * attach <handle>` for a child, and `--project <project> attach --conversation <id>` for a conversation.
 */
export function harnessArgs(target: MirrorTarget): string[] {
	if (target.conversation !== undefined) {
		return ["--project", target.project, "attach", "--conversation", target.conversation];
	}

	return target.handle === AGENT_HANDLE ? [target.project] : ["--project", target.project, "attach", target.handle];
}

/** The title of the agent of `target` before the host gives its name: the handle or the conversation ID of a child. */
export function targetTitle(target: MirrorTarget): string {
	if (target.conversation !== undefined) return target.conversation;

	return target.handle === AGENT_HANDLE ? `${target.project} agent` : target.handle;
}

/** A change of the model or the thinking level of the mirrored conversation. */
export type MirrorConfigure = Omit<Extract<Request, { type: "configure" }>, "type" | "handle">;

/**
 * The connection of a mirror: before the first one, open, connecting again after the host closed it, or failed for
 * good, with the reason.
 */
export type MirrorStatus =
	| { readonly kind: "connecting" | "open" | "reconnecting" }
	| { readonly kind: "failed"; readonly reason: string };

export type MirrorOptions = {
	/** The waits before the tries to connect again after the host closed the connection. Default 0, 2 and 5 s. */
	readonly retryDelaysMs?: readonly number[];
	/** Whether a connection starts the host when none runs. Default true. */
	readonly start?: boolean;
};

const HOST_CLOSED = "The harness host closed the connection";

/**
 * The error of a message that went to the host on a connection that closed before the host answered, when the mirror
 * then failed: the host may have the message or not.
 */
export class PossiblySentError extends Error {}

/**
 * A message that waits until the host has it. It keeps its request ID when it goes again. `written` tells that it went
 * on a connection once, so the host may have it.
 */
type Outgoing = {
	readonly requestId: string;
	readonly message: string;
	readonly followUp: boolean;
	readonly sent: PromiseWithResolvers<void>;
	written: boolean;
};

type Watched = Awaited<ReturnType<Client["watch"]>> & { readonly client: Client };

/**
 * A live copy of one conversation of a harness host, and the requests that act on it. It connects at once, which starts
 * the host when none runs, and connects again when the host closes the connection, with one try after each of
 * `retryDelaysMs`. It fails for good when the first connection fails, when all the tries fail, when the child is
 * stopped, when the host closes a connection that was opened again less than 10 s before, so that a host that fails
 * at each start does not start again and again, and when it closes. `onChange` runs after each change of `status`, `view` and `child`, with
 * the status before the change.
 */
export class Mirror {
	readonly target: MirrorTarget;
	/** The target of the requests: the handle or the conversation of `target`, without the project. */
	readonly #ref: Target;
	readonly #onChange: (previous: MirrorStatus) => void;
	readonly #retryDelaysMs: readonly number[];
	readonly #start: boolean;
	/** Stops the wait for a host that starts, and the waits between the tries, when the mirror closes. */
	readonly #closing = new AbortController();
	/** The messages that the host does not have yet, in the order of `send`. */
	readonly #outgoing: Outgoing[] = [];
	#status: MirrorStatus = { kind: "connecting" };
	#view: ConversationView | undefined;
	#child: ChildInfo | undefined;
	#client: Client | undefined;
	#sending = false;

	constructor(target: MirrorTarget, onChange: (previous: MirrorStatus) => void, options: MirrorOptions = {}) {
		this.target = target;
		this.#ref = target.conversation === undefined ? { handle: target.handle } : { conversation: target.conversation };
		this.#onChange = onChange;
		this.#retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
		this.#start = options.start ?? true;
		void this.#run();
	}

	get status(): MirrorStatus {
		return this.#status;
	}

	/** The conversation, as the last connection gave it. It is undefined before the first connection. */
	get view(): ConversationView | undefined {
		return this.#view;
	}

	/** The child or the project agent, as the last connection gave it. It is undefined before the first connection. */
	get child(): ChildInfo | undefined {
		return this.#child;
	}

	/** Whether the conversation works, as an open connection tells. */
	get busy(): boolean {
		return this.#status.kind === "open" && this.#child?.state === "busy";
	}

	/**
	 * Sends `message`: a new turn when the conversation is idle, else a steer, or a follow-up with `followUp`. It resolves
	 * once the host has the message. The message waits while the mirror connects. When its connection closes before the
	 * host answers, it goes again on the next connection with the same request ID, so that the host takes it once. It
	 * rejects when the host refuses the message, and when the mirror fails or closes before the host has it. When the
	 * mirror fails after the message went to the host without an answer, the error is a `PossiblySentError`.
	 */
	send(message: string, followUp: boolean): Promise<void> {
		if (this.#status.kind === "failed") return Promise.reject(new Error(this.#status.reason));

		if (this.#closing.signal.aborted) return Promise.reject(new Error("The mirror is closed"));

		const outgoing = {
			requestId: randomUUID(),
			message,
			followUp,
			sent: Promise.withResolvers<void>(),
			written: false,
		};

		this.#outgoing.push(outgoing);
		void this.#flush();

		return outgoing.sent.promise;
	}

	/** Aborts the turn, and gives the texts of the queued messages that the host withdraws, steers first. */
	async abort(): Promise<string[]> {
		const { client, view } = this.#connection();
		const texts = withdrawnTexts(inboxOf(view));
		this.#setChild(await client.request({ type: "abort", ...this.#ref }));

		return texts;
	}

	/**
	 * Changes the model or the thinking level. The host refuses a model it does not know and a level it does not have. A
	 * conversation of the children library refuses it without a request.
	 */
	async configure(change: MirrorConfigure): Promise<void> {
		const { handle } = this.target;

		if (handle === undefined) {
			throw new Error("A conversation of the children library keeps its model and thinking level");
		}

		const { client } = this.#connection();
		this.#setChild(await client.request({ type: "configure", handle, ...change }));
	}

	/**
	 * Closes the connection and stops connecting. The status becomes failed with `The mirror is closed`, unless it failed
	 * before, and `onChange` does not run: the caller knows. The conversation keeps running in the host.
	 */
	close(): void {
		this.#closing.abort();
		this.#client?.close();

		for (const outgoing of this.#outgoing.splice(0)) outgoing.sent.reject(new Error("The mirror is closed"));

		if (this.#status.kind !== "failed") this.#status = { kind: "failed", reason: "The mirror is closed" };
	}

	/** Connects, follows the watch, and connects again after the host closed the connection, until a failure or `close()`. */
	async #run(): Promise<void> {
		let attempt = await this.#connect([0]);
		let again = false;

		while (!(attempt instanceof Error)) {
			const opened = Date.now();
			this.#client = attempt.client;
			this.#view = attempt.view;
			this.#child = attempt.child;
			this.#setStatus({ kind: "open" });
			void this.#flush();
			const end = await this.#follow(attempt.view, attempt.lines);
			this.#client = undefined;
			attempt.client.close();

			if (this.#closing.signal.aborted) return;

			if (end === "stopped") {
				this.#fail(`${runDisplayName(this.#child ?? attempt.child)} was stopped`);

				return;
			}

			if (again && Date.now() - opened < SHORT_CONNECTION_MS) {
				this.#fail(`${HOST_CLOSED}. Run /reload to attach again`);

				return;
			}

			again = true;
			this.#setStatus({ kind: "reconnecting" });
			attempt = await this.#connect(this.#retryDelaysMs);
		}

		if (this.#closing.signal.aborted) return;
		this.#fail(again ? `${HOST_CLOSED}. Connecting again failed: ${attempt.message}` : attempt.message);
	}

	/**
	 * A connection with the watch of the target, after one try at each delay of `delays`. It is the error of the last try
	 * when all the tries fail, and an error after `close()`.
	 */
	async #connect(delays: readonly number[]): Promise<Watched | Error> {
		const { signal } = this.#closing;

		const attempt = await tryEach(delays, signal, async (): Promise<Watched> => {
			const client = await connect({ start: this.#start, project: this.target.project, signal });

			if (client === undefined) throw new Error("Could not connect to the harness host");

			try {
				return { ...(await client.watch(this.#ref)), client };
			} catch (cause) {
				client.close();
				throw cause;
			}
		});

		if (!signal.aborted) return attempt;

		if (!(attempt instanceof Error)) attempt.client.close();

		return new Error("The mirror is closed");
	}

	/** Applies each change of the watch until it ends: `stopped` when the child was stopped, else `closed`. */
	async #follow(view: ConversationView, lines: AsyncIterable<WatchLine>): Promise<"stopped" | "closed"> {
		let current = view;

		for await (const line of lines) {
			if (line.stopped) return "stopped";
			current = applyChange(current, line.change);
			this.#view = current;
			this.#child = line.child;
			this.#onChange(this.#status);
		}

		return "closed";
	}

	/** Sends the waiting messages on the open connection, one at a time, in order. */
	async #flush(): Promise<void> {
		if (this.#sending) return;
		this.#sending = true;

		try {
			for (let next = this.#outgoing[0]; next !== undefined; next = this.#outgoing[0]) {
				const client = this.#client;

				if (client === undefined) return;
				const { requestId, message, followUp } = next;
				next.written ||= !client.ended;

				try {
					const reply = await client.request({
						type: "input",
						requestId,
						...this.#ref,
						message,
						followUp,
					});

					// `close()` and a failure settle the waiting messages themselves.
					if (this.#outgoing[0] !== next) return;
					this.#outgoing.shift();
					this.#setChild(reply.child);
					next.sent.resolve();
				} catch (error) {
					// After the end of the connection, the host may have the message or not, so it goes again.
					if (client.ended || this.#outgoing[0] !== next) return;
					this.#outgoing.shift();
					next.sent.reject(error);
				}
			}
		} finally {
			this.#sending = false;
		}
	}

	/** The open connection and its view, or an error without one. */
	#connection() {
		const client = this.#client;
		const view = this.#view;

		if (client === undefined || view === undefined) throw new Error("Not connected to the harness host");

		return { client, view };
	}

	#fail(reason: string): void {
		for (const outgoing of this.#outgoing.splice(0)) {
			outgoing.sent.reject(outgoing.written ? new PossiblySentError(reason) : new Error(reason));
		}

		this.#setStatus({ kind: "failed", reason });
	}

	#setStatus(status: MirrorStatus): void {
		const previous = this.#status;
		this.#status = status;
		this.#onChange(previous);
	}

	#setChild(child: ChildInfo): void {
		this.#child = child;
		this.#onChange(this.#status);
	}
}
