/**
 * The push of the answers of children to their callers: a caller in the host gets them as input, another caller as the
 * reply to its open `answers` request.
 */
import type { Socket } from "node:net";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type CommitChange, type Conversation, LiveDoc } from "@earendil-works/pi-durable";
import type { Answer, Child, Input } from "./children.ts";
import { AGENT_HANDLE, type Delivery, deliveryText } from "./protocol.ts";
import {
	type ChildRecord,
	Children,
	childOf,
	childTarget,
	library,
	markRead,
	type TargetHost,
	target,
} from "./targets.ts";
import { isHeld, unreadAnswers, unreadNotify } from "./unread.ts";

const context = BACKGROUND_CONTEXT;

const PUSH_PREFIX = "push:";

/** What the push uses of the host. */
export type PushHost = TargetHost & {
	/** The root conversation, which is the project agent. */
	readonly root: Conversation;
	readonly warn: (cause: unknown) => void;
};

/**
 * The socket of a request, and a hook that runs `run` once the reply goes to the socket. `written` resolves once the
 * write ends, with false when it failed.
 */
export type Connection = {
	readonly socket: Socket;
	afterReply(run: (written: Promise<boolean>) => void): void;
};

/** An open `answers` request. */
type Listener = {
	readonly socket: Socket;
	/** Resolves once the reply is written, with false when the write failed. */
	readonly written: Promise<boolean>;
	readonly resolve: (deliveries: readonly Delivery[]) => void;
};

/** The answers of one child that a sweep takes. They become read up to `read`, and `main` is the last one. */
type Taken = { readonly delivery: Delivery; readonly handle: string; readonly read: number; readonly main: string };

/** Where the answers of a caller go: its open `answers` request, or the input of a conversation of the host. */
type Destination =
	| { readonly kind: "reply" }
	| { readonly kind: "input"; readonly send: (input: Input) => Promise<void> };

/** The end of the next sweep, and a function that stops waiting for it. */
type NextSweep = { readonly ended: Promise<void>; readonly cancel: () => void };

type Entry = readonly [handle: string, record: ChildRecord];

/**
 * Pushes the unread answers of each child that is done to its caller. A child is done when its own turn ended and no
 * child of its own holds it. A sweep runs at the start, after each commit that can end a turn or change a record, at
 * the end of each `wait` and `send`, and when an `answers` request opens or its reply is written. Calls for a sweep
 * while one runs give one more sweep.
 */
export class Push {
	readonly #host: PushHost;
	/** The number of waits and sends in progress for each handle. A sweep does not push the answers of such a child. */
	readonly #active = new Map<string, number>();
	/** The children whose answers are in a reply that is not written yet. A sweep skips them, and a wait waits for them. */
	readonly #writing = new Map<string, Promise<void>>();
	/** The open `answers` request of each caller that is not a conversation of the host. */
	readonly #listeners = new Map<string, Listener>();
	/** Called at the end of the next sweep. */
	readonly #sweepEnds = new Set<() => void>();
	readonly #unsubscribe: () => void;
	#dirty = false;
	#running = false;
	#closed = false;

	/** Writes `cause` as a warning, and gives nothing. */
	readonly #warn = (cause: unknown): undefined => {
		this.#host.warn(cause);

		return undefined;
	};

	constructor(host: PushHost) {
		this.#host = host;
		// The listener only schedules a sweep: it must not call the store.
		this.#unsubscribe = host.harness.subscribeCommits((publication) => {
			if (publication.changes.some(endsTurn)) this.schedule();
		});
		this.schedule();
	}

	/** Schedules a sweep. */
	schedule(): void {
		this.#dirty = true;

		if (this.#running || this.#closed) return;
		this.#running = true;
		// Out of the commit listener, which must not call the store.
		setImmediate(() => void this.#run());
	}

	/** Runs `run` while `handle` counts as active, then sweeps: a sweep does not push the answers of an active child. */
	async whileActive<T>(handle: string, run: () => Promise<T>): Promise<T> {
		this.#active.set(handle, (this.#active.get(handle) ?? 0) + 1);

		try {
			return await run();
		} finally {
			const count = (this.#active.get(handle) ?? 1) - 1;

			if (count > 0) this.#active.set(handle, count);
			else this.#active.delete(handle);
			this.schedule();
		}
	}

	/**
	 * The last request of `child` and its answer, once the child is done: its own turn ended and none of its children
	 * holds it. While its children hold it, the child gets their pushes, and the input of each push becomes its last
	 * request.
	 */
	async done(child: Child, signal: AbortSignal): Promise<{ readonly main: string | null; readonly answer: Answer }> {
		const waiting = withAbortSignal(signal, context);
		let main = await child.lastRequest(waiting);
		let answer = await child.settled(waiting, main ?? undefined);

		for (;;) {
			// Listen before the checks, so that a sweep that ends during them is not missed.
			const sweep = this.#nextSweep(signal);

			try {
				const latest = await child.lastRequest(waiting);

				if (latest !== null && latest !== main && isPushRequest(latest)) {
					main = latest;
					answer = await child.settled(waiting, main);
					continue;
				}

				if (!isHeld(await this.#host.harness.snapshot(Children, waiting), child.id)) return { main, answer };
				await sweep.ended;
			} finally {
				sweep.cancel();
			}

			signal.throwIfAborted();
		}
	}

	/** `ended` resolves at the end of the next sweep, or when `signal` aborts. `cancel()` stops listening. */
	#nextSweep(signal: AbortSignal): NextSweep {
		const { promise, resolve } = Promise.withResolvers<void>();

		const end = () => {
			signal.removeEventListener("abort", end);
			this.#sweepEnds.delete(end);
			resolve();
		};

		this.#sweepEnds.add(end);
		signal.addEventListener("abort", end, { once: true });

		return { ended: promise, cancel: end };
	}

	/** Resolves once the reply with the answers of `handle` that a push gives is written, or at once without one. */
	written(handle: string): Promise<void> {
		return this.#writing.get(handle) ?? Promise.resolve();
	}

	/**
	 * Opens the `answers` request of `caller` on `reply`, in place of an older one, and sweeps. The reply comes with the
	 * next answers that a sweep pushes to the caller. Those answers become read only once the reply is written; when the
	 * write fails, or `signal` aborts first, they stay unread for the next request or a `wait`.
	 */
	listen(caller: string, reply: Connection, signal: AbortSignal): Promise<readonly Delivery[]> {
		const deliveries = Promise.withResolvers<readonly Delivery[]>();
		const written = Promise.withResolvers<boolean>();
		reply.afterReply(written.resolve);
		const listener: Listener = { socket: reply.socket, written: written.promise, resolve: deliveries.resolve };
		this.#listeners.set(caller, listener);
		signal.addEventListener(
			"abort",
			() => {
				if (this.#listeners.get(caller) === listener) this.#listeners.delete(caller);
				deliveries.reject(new Error("The connection closed"));
			},
			{ once: true },
		);
		this.schedule();

		return deliveries.promise;
	}

	/** Whether `socket` has an open `answers` request. */
	listens(socket: Socket): boolean {
		return [...this.#listeners.values()].some((listener) => listener.socket === socket);
	}

	/** Stops the sweeps. */
	close(): void {
		this.#closed = true;
		this.#unsubscribe();
	}

	async #run(): Promise<void> {
		while (this.#dirty && !this.#closed) {
			this.#dirty = false;
			await this.#sweep().catch(this.#warn);
			const ends = [...this.#sweepEnds];
			this.#sweepEnds.clear();

			for (const end of ends) end();
		}

		this.#running = false;
	}

	/** Pushes the answers of the children that are done, for each caller with a destination, oldest child first. */
	async #sweep(): Promise<void> {
		const state = await this.#host.harness.snapshot(Children, context);
		const entries: Entry[] = Object.entries(state?.children ?? {});
		entries.sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
		const done = new Map<string, Entry[]>();

		for (const entry of entries) {
			const [handle, record] = entry;
			const skip = !unreadNotify(record) || this.#active.has(handle) || this.#writing.has(handle);

			if (!skip && !isHeld(state, record.conversationId))
				done.set(record.caller, [...(done.get(record.caller) ?? []), entry]);
		}

		for (const [caller, children] of done) {
			const destination = await this.#destination(caller, entries).catch(this.#warn);

			if (destination === undefined) continue;
			const taken: Taken[] = [];

			for (const [handle, record] of children) {
				const one = await this.#take(handle, record).catch(this.#warn);

				if (one !== undefined) taken.push(one);
			}

			if (taken.length > 0) await this.#deliver(caller, destination, taken).catch(this.#warn);
		}
	}

	/**
	 * Where the answers for `caller` go: its open `answers` request, else the input of a conversation of the host (a
	 * child, the project agent, or another conversation of the children library, such as a child of a task). Nothing for
	 * another caller, such as a Pi session without an open request: its answers stay unread.
	 */
	async #destination(caller: string, entries: readonly Entry[]): Promise<Destination | undefined> {
		if (this.#listeners.has(caller)) return { kind: "reply" };
		const send = await this.#input(caller, entries);

		return send === undefined ? undefined : { kind: "input", send };
	}

	/** Delivers the answers that a sweep took for `caller` to `destination`, oldest child first, and marks them read. */
	async #deliver(caller: string, destination: Destination, taken: readonly Taken[]): Promise<void> {
		switch (destination.kind) {
			case "reply":
				this.#reply(caller, taken);

				return;
			case "input":
				for (const { delivery, handle, read, main } of taken) {
					// The caller is busy with the input before the child stops holding it, and a repeated push finds the first one.
					await destination.send({
						type: "input",
						content: deliveryText(delivery),
						whenBusy: "followUp",
						requestId: `${PUSH_PREFIX}${handle}:${read}`,
					});
					await markRead(this.#host.harness, handle, read, main);
				}
		}
	}

	/** The input of `caller` when it is a conversation of the host. */
	async #input(caller: string, entries: readonly Entry[]): Promise<((input: Input) => Promise<void>) | undefined> {
		const parent = entries.find(([, record]) => String(record.conversationId) === caller);

		if (parent !== undefined) return (await childTarget(this.#host, ...parent)).send;

		if (caller === String(this.#host.root.id)) return (await target(this.#host, { handle: AGENT_HANDLE })).send;
		const conversation = (await library.inspect(this.#host.place, caller, context))?.conversation;

		if (conversation === undefined) return undefined;

		return async (input) => {
			await conversation.submit(input, context);
		};
	}

	/** Replies to the open `answers` request of `caller` with `taken`, which becomes read once the reply is written. */
	#reply(caller: string, taken: readonly Taken[]): void {
		const listener = this.#listeners.get(caller);

		if (listener === undefined) return;
		this.#listeners.delete(caller);

		const marked = listener.written.then(async (ok) => {
			if (!ok) return;

			for (const { handle, read, main } of taken) {
				await markRead(this.#host.harness, handle, read, main).catch(this.#warn);
			}
		});

		for (const { handle } of taken) {
			const done: Promise<void> = marked.finally(() => {
				if (this.#writing.get(handle) === done) this.#writing.delete(handle);
				this.schedule();
			});

			this.#writing.set(handle, done);
		}

		listener.resolve(taken.map(({ delivery }) => delivery));
	}

	/**
	 * The unread answers of `handle` once its turn ended, as `wait` gives them; nothing when no answer is new. Input from
	 * a mirror session sends nothing up: its turn is not the main request, the caller's last request is.
	 */
	async #take(handle: string, record: ChildRecord): Promise<Taken | undefined> {
		const child = await childOf(this.#host, record);
		const state = await child.state(context);

		if (state === "busy" || state === "closed") return undefined;
		const last = await child.lastRequest(context);
		const sent = record.sent ?? [];

		if (last === null) return undefined;
		const main = sent.includes(last) || isPushRequest(last) ? last : sent.at(-1);

		if (main === undefined) return undefined;
		const answer = await child.settled(context, main);
		const { text, failed, read } = await unreadAnswers(child, handle, record, main, answer, sent, context);

		if (read <= (record.read ?? 0)) return undefined;
		const delivery = record.name === undefined ? { handle, text, failed } : { handle, name: record.name, text, failed };

		return { delivery, handle, read, main };
	}
}

/** Whether `requestId` is the input of a push, which a child gets from its own children. */
function isPushRequest(requestId: string): boolean {
	return requestId.startsWith(PUSH_PREFIX);
}

/** Whether `change` can end a turn or change a record: a live document without a run, or the `Children` document. */
function endsTurn(change: CommitChange): boolean {
	if (change.type !== "document") return false;

	if (change.record.kind === Children.definition.kind) return true;

	return change.record.kind === LiveDoc.definition.kind && change.value?.run === undefined;
}
