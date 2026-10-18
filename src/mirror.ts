/**
 * A mirror session is a Pi session that shows a conversation of a harness host and sends what the user types to it.
 * The conversation stays in the host; the Pi session keeps only its target, in one custom entry. This module has no
 * runtime import of Pi, chord or pi-durable, so the Pi extension can load it.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConversationView } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type Client, connect } from "./client.ts";
import { applyChange, type ChildInfo, type Request, runDisplayName, type WatchLine } from "./protocol.ts";
import { inboxOf, withdrawnTexts } from "./view-state.ts";

/** The `customType` of the session entry that holds the target of a mirror session. */
export const MIRROR_ENTRY = "harness-mirror";

/** The conversation that a mirror session shows: the child or project agent `handle` of the host of `project`. */
export const MirrorTarget = Type.Object({ project: Type.String(), handle: Type.String() });

export type MirrorTarget = Static<typeof MirrorTarget>;

/** Whether the data of a session entry is a mirror target. */
export function isMirrorTarget(data: unknown): data is MirrorTarget {
	return Value.Check(MirrorTarget, data);
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

const RETRY_DELAYS_MS = [0, 2000, 5000];

/** A connection that was opened again and ends sooner than this is not opened again: the host fails at each start. */
const SHORT_CONNECTION_MS = 10_000;

const HOST_CLOSED = "The harness host closed the connection";

/** A message that waits until the host has it. It keeps its request ID when it goes again. */
type Outgoing = {
	readonly requestId: string;
	readonly message: string;
	readonly followUp: boolean;
	readonly sent: PromiseWithResolvers<void>;
};

type Watched = Awaited<ReturnType<Client["watch"]>> & { readonly client: Client };

/**
 * A live copy of one conversation of a harness host, and the requests that act on it. It connects at once, which starts
 * the host when none runs, and connects again when the host closes the connection, with one try after each of
 * `retryDelaysMs`. It fails for good when the first connection fails, when all the tries fail, when the child is
 * stopped, and when the host closes a connection that was opened again less than 10 s before, so that a host that fails
 * at each start does not start again and again. `onChange` runs after each change of `status`, `view` and `child`.
 */
export class Mirror {
	readonly target: MirrorTarget;
	readonly #onChange: () => void;
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

	constructor(target: MirrorTarget, onChange: () => void, options: MirrorOptions = {}) {
		this.target = target;
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
	 * rejects when the host refuses the message, and when the mirror fails or closes before the host has it.
	 */
	send(message: string, followUp: boolean): Promise<void> {
		if (this.#status.kind === "failed") return Promise.reject(new Error(this.#status.reason));

		if (this.#closing.signal.aborted) return Promise.reject(new Error("The mirror is closed"));
		const outgoing = { requestId: randomUUID(), message, followUp, sent: Promise.withResolvers<void>() };
		this.#outgoing.push(outgoing);
		void this.#flush();

		return outgoing.sent.promise;
	}

	/** Aborts the turn, and gives the texts of the queued messages that the host withdraws, steers first. */
	async abort(): Promise<string[]> {
		const { client, view } = this.#connection();
		const texts = withdrawnTexts(inboxOf(view));
		this.#setChild(await client.request({ type: "abort", handle: this.target.handle }));

		return texts;
	}

	/** Changes the model or the thinking level. The host refuses a model it does not know and a level it does not have. */
	async configure(change: MirrorConfigure): Promise<void> {
		const { client } = this.#connection();
		this.#setChild(await client.request({ type: "configure", handle: this.target.handle, ...change }));
	}

	/** Closes the connection and stops connecting. The conversation keeps running in the host. */
	close(): void {
		this.#closing.abort();
		this.#client?.close();
		this.#reject(new Error("The mirror is closed"));
	}

	/** Connects, follows the watch, and connects again after the host closed the connection, until a failure or `close()`. */
	async #run(): Promise<void> {
		let watched = await this.#connect([0], (error) => error);
		let again = false;

		while (watched !== undefined) {
			const opened = Date.now();
			this.#client = watched.client;
			this.#view = watched.view;
			this.#child = watched.child;
			this.#setStatus({ kind: "open" });
			void this.#flush();
			const end = await this.#follow(watched.view, watched.lines);
			this.#client = undefined;
			watched.client.close();

			if (this.#closing.signal.aborted) return;

			if (end === "stopped") {
				this.#fail(`${runDisplayName(this.#child ?? watched.child)} was stopped`);

				return;
			}

			if (again && Date.now() - opened < SHORT_CONNECTION_MS) {
				this.#fail(`${HOST_CLOSED}. Run /reload to attach again`);

				return;
			}

			again = true;
			this.#setStatus({ kind: "reconnecting" });
			watched = await this.#connect(
				this.#retryDelaysMs,
				(error) => `${HOST_CLOSED}. Connecting again failed: ${error}`,
			);
		}
	}

	/**
	 * A connection with the watch of the target, after one try at each delay of `delays`. When all the tries fail, the
	 * mirror fails with the reason that `failure` makes of the last error. It is undefined then, and after `close()`.
	 */
	async #connect(delays: readonly number[], failure: (error: string) => string): Promise<Watched | undefined> {
		const { signal } = this.#closing;
		let error = "";

		for (const delay of delays) {
			if (delay > 0) await sleep(delay, undefined, { signal }).catch(() => {});

			if (signal.aborted) return undefined;
			let client: Client | undefined;

			try {
				client = await connect({ start: this.#start, project: this.target.project, signal });

				if (client === undefined) throw new Error("Could not connect to the harness host");
				const watched = await client.watch(this.target.handle);

				if (signal.aborted) {
					client.close();

					return undefined;
				}

				return { ...watched, client };
			} catch (cause) {
				client?.close();
				error = cause instanceof Error ? cause.message : String(cause);
			}
		}

		if (!signal.aborted) this.#fail(failure(error));

		return undefined;
	}

	/** Applies each change of the watch until it ends: `stopped` when the child was stopped, else `closed`. */
	async #follow(view: ConversationView, lines: AsyncIterable<WatchLine>): Promise<"stopped" | "closed"> {
		let current = view;

		for await (const line of lines) {
			if (line.stopped) return "stopped";
			current = applyChange(current, line.change);
			this.#view = current;
			this.#child = line.child;
			this.#onChange();
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

				try {
					const reply = await client.request({
						type: "input",
						requestId,
						handle: this.target.handle,
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
		this.#status = { kind: "failed", reason };
		this.#reject(new Error(reason));
		this.#onChange();
	}

	/** Rejects the waiting messages with `error`. */
	#reject(error: Error): void {
		for (const outgoing of this.#outgoing.splice(0)) outgoing.sent.reject(error);
	}

	#setStatus(status: MirrorStatus): void {
		this.#status = status;
		this.#onChange();
	}

	#setChild(child: ChildInfo): void {
		this.#child = child;
		this.#onChange();
	}
}
