/**
 * The watch of a state that the host reads from its store: the state in the reply, then events with what changed after
 * the commits that can change it.
 */
import { once } from "node:events";
import type { Socket } from "node:net";
import type { CommitChange, CommitObservation, Harness } from "@earendil-works/pi-durable";
import { Passes } from "./passes.ts";
import type { Connection } from "./push.ts";

/** What a watch reads, the events that it sends, and the commits that start a pass. */
export type StoreView<S, E> = {
	/** Reads the state. */
	read(): Promise<S>;
	/** The events from `before`, which the client has, to `after`: with every object when `all` is true. */
	events(before: S, after: S, all: boolean): E[];
	/** Whether `change` can change the state. It gets every change of every commit, in order, and must not call the store. */
	changes(change: CommitChange): boolean;
};

/**
 * Opens a watch of `view` on `connection`, and returns the reply, with the state. A pass runs once the reply is
 * written, and after it each commit with a change that `view` marks starts a pass: the host reads the state again and
 * sends a `{ event }` line for each event of `view`. The passes run one at a time, and the commits during a pass give
 * one more pass. When a write waits for a slow socket to drain, the next events have every object. A pass that fails,
 * and the close of the store, end the connection. The watch stops when `signal` aborts, at the close of the socket.
 */
export async function serveStoreWatch<S, E>(
	harness: Pick<Harness, "observeCommits">,
	view: StoreView<S, E>,
	signal: AbortSignal,
	connection: Connection,
): Promise<S> {
	// The observer attaches before the first read, so a commit during the read gives a pass.
	const watch = new StoreWatch(harness, view, connection.socket);
	let state: S;

	try {
		state = await watch.open();
	} catch (error) {
		watch.stop();
		throw error;
	}

	if (signal.aborted) watch.stop();
	else signal.addEventListener("abort", () => watch.stop(), { once: true });
	// The events come after the reply.
	connection.afterReply(() => watch.start());

	return state;
}

/** The passes of one watch, and what its client has. */
class StoreWatch<S, E> {
	readonly #view: StoreView<S, E>;
	readonly #socket: Socket;
	readonly #observation: CommitObservation;
	readonly #passes = new Passes(() => this.#pass().catch(() => this.#end()));
	/** The state that the client has, once the reply is read. */
	#sent: { readonly state: S } | undefined;
	/** Whether the reply is written, so the commits give passes. */
	#started = false;
	/** Whether the last write waited for the socket to drain, so the next events have every object. */
	#behind = false;

	constructor(harness: Pick<Harness, "observeCommits">, view: StoreView<S, E>, socket: Socket) {
		this.#view = view;
		this.#socket = socket;
		// The listener only requests a pass: it must not call the store. The view sees every change, so its own state stays
		// current.
		this.#observation = harness.observeCommits({
			advance: (publication) => {
				const marks = publication.changes.map((change) => view.changes(change));

				if (this.#started && marks.includes(true)) this.#passes.request();
			},
			end: () => this.#end(),
		});
	}

	/** Reads the state that the reply gives, which the client then has. */
	async open(): Promise<S> {
		const state = await this.#view.read();
		this.#sent = { state };

		return state;
	}

	/**
	 * Lets the passes run, once the reply is written, and runs one. It sends what changed since the reply, so the commits
	 * before it need no pass of their own.
	 */
	start(): void {
		this.#started = true;
		this.#passes.request();
	}

	/** Stops the passes. */
	stop(): void {
		this.#passes.stop();
		this.#observation.detach();
	}

	/** Stops the passes and ends the connection. */
	#end(): void {
		this.stop();

		if (this.#socket.writable) this.#socket.end();
	}

	/**
	 * Reads the state, and sends the events from what the client has. When it fails, the watch ends the connection, and
	 * the client opens the watch again to get the whole state.
	 */
	async #pass(): Promise<void> {
		const state = await this.#view.read();

		if (this.#passes.stopped || !this.#socket.writable || this.#sent === undefined) return;
		const events = this.#view.events(this.#sent.state, state, this.#behind);
		this.#sent = { state };
		this.#behind = false;
		const writes = events.map((event) => this.#socket.write(`${JSON.stringify({ event })}\n`));

		if (writes.includes(false)) {
			this.#behind = true;
			// A socket that closes first never drains: the wait then goes with it.
			await once(this.#socket, "drain").catch(() => {});
		}
	}
}
