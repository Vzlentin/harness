/**
 * The watch of a state that the host reads from its store: the state in the reply, then events with what changed after
 * the commits that can change it, through a sink: the socket of a connection, or the calls of the watch of an entry.
 * It also holds the sink of a watch on the socket of a connection, which the watches of the entries use too.
 */
import { once } from "node:events";
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
	/**
	 * Calls `request` when the state changes with no commit, and gives the function that stops it. A view without it
	 * changes only with commits.
	 */
	triggers?(request: () => void): () => void;
};

/** Where a watch sends its events. */
export type WatchSink<E> = {
	/** Sends `event`. It is false when the client must drain first. */
	emit(event: E): boolean;
	/** Resolves once the client drained. */
	drained(): Promise<void>;
	/** Ends the watch for the client. */
	end(): void;
};

/** What a watch gets: the sink of its events, and the signal that stops it. */
export type ConnectionWatchOptions<E> = WatchSink<E> & {
	/** Aborts when the socket or the host closes. */
	readonly signal: AbortSignal;
};

/**
 * Opens the watch `watch` on `connection`, and returns its state as the reply. Each `emit` of the watch becomes one
 * `{ event }` line after the reply, in order: the events before the reply wait for it. `emit` is false when the socket
 * holds the line until it drains, and `drained` waits for that. `end` ends the connection once the reply and the events
 * before it are written. A watch that fails sends no event.
 */
export async function serveConnectionWatch<S, E>(
	connection: Connection,
	signal: AbortSignal,
	watch: (options: ConnectionWatchOptions<E>) => Promise<S>,
): Promise<S> {
	const { socket } = connection;
	/** The events that wait for the reply, until it is written. */
	let waiting: E[] | undefined = [];
	let ended = false;

	const write = (event: E) => !socket.writable || socket.write(`${JSON.stringify({ event })}\n`);

	const close = () => {
		if (socket.writable) socket.end();
	};

	const emit = (event: E) => {
		if (ended) return true;

		if (waiting === undefined) return write(event);
		waiting.push(event);

		return true;
	};

	// A socket that closes first never drains: the wait then goes with it.
	const drained = () =>
		socket.writableNeedDrain
			? once(socket, "drain").then(
					() => undefined,
					() => undefined,
				)
			: Promise.resolve();

	const end = () => {
		if (ended) return;
		ended = true;

		if (waiting === undefined) close();
	};

	let state: S;

	try {
		state = await watch({ signal, emit, drained, end });
	} catch (error) {
		ended = true;
		throw error;
	}

	connection.afterReply(() => {
		const events = waiting ?? [];
		waiting = undefined;

		for (const event of events) write(event);

		if (ended) close();
	});

	return state;
}

/**
 * Opens a watch of `view` on `connection`, and returns the reply, with the state. A pass runs at once, and its events
 * wait for the reply. After it, each commit with a change that `view` marks, and each trigger of `view`, starts a pass:
 * the host reads the state again and sends a `{ event }` line for each event of `view`. The passes run one at a time,
 * and the commits during a pass give one more pass. When a write waits for a slow socket to drain, the next events have
 * every object. A pass that fails, and the close of the store, end the connection. The watch stops when `signal`
 * aborts, at the close of the socket.
 */
export function serveStoreWatch<S, E>(
	harness: Pick<Harness, "observeCommits">,
	view: StoreView<S, E>,
	signal: AbortSignal,
	connection: Connection,
): Promise<S> {
	return serveConnectionWatch(connection, signal, (options) => watchStore(harness, view, options));
}

/**
 * Opens a watch of `view` that sends its events to the sink in `options`, and returns the state. A pass runs once the
 * state is read, and each commit with a change that `view` marks, and each trigger of `view`, then starts a pass, as
 * `serveStoreWatch` says. A pass that fails, and the close of the store, end the sink. The watch stops when the signal
 * in `options` aborts.
 */
export async function watchStore<S, E>(
	harness: Pick<Harness, "observeCommits">,
	view: StoreView<S, E>,
	options: ConnectionWatchOptions<E>,
): Promise<S> {
	// The observer attaches before the first read, so a commit during the read gives a pass.
	const watch = new StoreWatch(harness, view, options);
	let state: S;

	try {
		state = await watch.open();
	} catch (error) {
		watch.stop();
		throw error;
	}

	// The first pass runs on a later turn, so a signal that aborted already cancels it.
	if (options.signal.aborted) watch.stop();
	else options.signal.addEventListener("abort", () => watch.stop(), { once: true });

	return state;
}

/** The passes of one watch, and what its client has. */
class StoreWatch<S, E> {
	readonly #view: StoreView<S, E>;
	readonly #sink: WatchSink<E>;
	readonly #observation: CommitObservation;
	/** Stops the triggers of the view. */
	readonly #untrigger: () => void;
	readonly #passes = new Passes(() => this.#pass().catch(() => this.#end()));
	/** The state that the client has, once the first read is done. Until then, a pass sends nothing. */
	#sent: { readonly state: S } | undefined;
	/** Whether the last write waited for the socket to drain, so the next events have every object. */
	#behind = false;

	constructor(harness: Pick<Harness, "observeCommits">, view: StoreView<S, E>, sink: WatchSink<E>) {
		this.#view = view;
		this.#sink = sink;
		// The listener only requests a pass: it must not call the store. The view sees every change, so its own state stays
		// current.
		this.#observation = harness.observeCommits({
			advance: (publication) => {
				const marks = publication.changes.map((change) => view.changes(change));

				if (marks.includes(true)) this.#passes.request();
			},
			end: () => this.#end(),
		});

		this.#untrigger = view.triggers?.(() => this.#passes.request()) ?? (() => {});
	}

	/**
	 * Reads the state that the reply gives, which the client then has, and requests a pass. That pass sends what changed
	 * since the state, so the commits during the read need no pass of their own.
	 */
	async open(): Promise<S> {
		const state = await this.#view.read();
		this.#sent = { state };
		this.#passes.request();

		return state;
	}

	/** Stops the passes. */
	stop(): void {
		this.#passes.stop();
		this.#observation.detach();
		this.#untrigger();
	}

	/** Stops the passes and ends the sink. */
	#end(): void {
		this.stop();
		this.#sink.end();
	}

	/**
	 * Reads the state, and sends the events from what the client has. When it fails, the watch ends the connection, and
	 * the client opens the watch again to get the whole state.
	 */
	async #pass(): Promise<void> {
		const state = await this.#view.read();

		if (this.#passes.stopped || this.#sent === undefined) return;
		const events = this.#view.events(this.#sent.state, state, this.#behind);
		this.#sent = { state };
		this.#behind = false;
		const writes = events.map((event) => this.#sink.emit(event));

		if (writes.includes(false)) {
			this.#behind = true;
			await this.#sink.drained();
		}
	}
}
