/**
 * The push of the answers of children to their callers, and of the answers of the user to their askers: a caller in the
 * host gets them as input, another caller as the reply to its open `answers` request.
 */
import type { Socket } from "node:net";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type CommitChange, type CommitObservation, type Conversation, LiveDoc } from "@earendil-works/pi-durable";
import type { Answer, Child, Input } from "../children/library.ts";
import { deliveryText } from "../protocol/labels.ts";
import { type Delivery, HOST_CLOSING } from "../protocol/requests.ts";
import { Passes } from "./passes.ts";
import {
	type ChildRecord,
	ChildRecords,
	conversationEntry,
	isHeld,
	isPushRequest,
	markRead,
	pushRequest,
	recordsByAge,
	unreadAnswers,
	unreadNotify,
} from "./records.ts";
import { childOf, childTarget, library, type TargetHost, target } from "./targets.ts";
import { readUserAnswers, removeUserAnswer, USER_ANSWERS_KIND, type UserAnswer } from "./user-answers.ts";

const context = BACKGROUND_CONTEXT;

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
	readonly reject: (cause: Error) => void;
};

/**
 * One delivery that a sweep takes for a caller: the answers of a child, or a queued answer of the user. `key` is the
 * handle of the child, or the request ID of the user answer. The input of the delivery has the request ID `requestId`,
 * and `settle()` marks the answers of the child read, or removes the user answer from the queue.
 */
type Pending = {
	readonly key: string;
	readonly delivery: Delivery;
	readonly requestId: string;
	readonly settle: () => Promise<void>;
};

/** Where the answers of a caller go: its open `answers` request, or the input of a conversation of the host. */
type Destination =
	| { readonly kind: "reply" }
	| { readonly kind: "input"; readonly send: (input: Input) => Promise<void> };

/** The end of the next sweep, and a function that stops waiting for it. */
type NextSweep = { readonly ended: Promise<void>; readonly cancel: () => void };

type Entry = readonly [handle: string, record: ChildRecord];

/** The failed pushes of a delivery in a row, and when the next try may run. */
type Failure = { readonly count: number; readonly retryAt: number };

/** The wait after the first failed push of a delivery. It doubles after each other failure, up to `MAX_RETRY_MS`. */
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;

/**
 * Pushes the unread answers of each child that is done to its caller. A child is done when its own turn ended and no
 * child of its own holds it. A sweep runs at the start, after each commit that can end a turn or change a record, at
 * the end of each `wait` and `send`, and when an `answers` request opens or its reply is written. Calls for a sweep
 * while one runs give one more sweep. After a push of a child fails, the sweeps skip that child for a time that doubles
 * with each failure, and a timer sweeps again when it ends. The answers of the user go to their askers in the same
 * sweeps, after the answers of the children of the same caller, oldest first, with the same waits.
 */
export class Push {
	readonly #host: PushHost;
	/** The number of waits and sends in progress for each handle. A sweep does not push the answers of such a child. */
	readonly #active = new Map<string, number>();
	/**
	 * The deliveries in a reply that is not written yet, by key. A sweep skips them, and a wait waits for those of its
	 * child.
	 */
	readonly #writing = new Map<string, Promise<void>>();
	/** The open `answers` request of each caller that is not a conversation of the host. */
	readonly #listeners = new Map<string, Listener>();
	/** Called at the end of the next sweep. */
	readonly #sweepEnds = new Set<() => void>();
	/** The deliveries whose last pushes failed, by key. */
	readonly #failures = new Map<string, Failure>();
	readonly #observation: CommitObservation;
	readonly #passes = new Passes(() => this.#pass());
	/** The timer of the sweep at the end of the earliest wait of `#failures`. */
	#retry: ReturnType<typeof setTimeout> | undefined;
	#closed = false;

	/** Writes `cause` as a warning, and gives nothing. */
	readonly #warn = (cause: unknown): undefined => {
		this.#host.warn(cause);

		return undefined;
	};

	constructor(host: PushHost) {
		this.#host = host;
		// The listener only schedules a sweep: it must not call the store.
		this.#observation = host.harness.observeCommits({
			advance: (publication) => {
				if (publication.changes.some(endsTurn)) this.schedule();
			},
			end: () => {},
		});
		this.schedule();
	}

	/** Schedules a sweep. */
	schedule(): void {
		this.#passes.request();
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
	 * request. It throws once the push closes.
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

				if (!isHeld(await this.#host.harness.snapshot(ChildRecords, waiting), child.id)) return { main, answer };
				await sweep.ended;
			} finally {
				sweep.cancel();
			}

			signal.throwIfAborted();

			if (this.#closed) throw new Error(HOST_CLOSING);
		}
	}

	/**
	 * `ended` resolves at the end of the next sweep, when `signal` aborts, or when the push closes, at once after it.
	 * `cancel()` stops listening.
	 */
	#nextSweep(signal: AbortSignal): NextSweep {
		const { promise, resolve } = Promise.withResolvers<void>();

		if (this.#closed) {
			resolve();

			return { ended: promise, cancel: () => {} };
		}

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
	 * write fails, or `signal` aborts first, they stay unread for the next request or a `wait`. The older request gets
	 * an error reply.
	 */
	listen(caller: string, reply: Connection, signal: AbortSignal): Promise<readonly Delivery[]> {
		const deliveries = Promise.withResolvers<readonly Delivery[]>();
		const written = Promise.withResolvers<boolean>();
		reply.afterReply(written.resolve);

		const listener: Listener = {
			socket: reply.socket,
			written: written.promise,
			resolve: deliveries.resolve,
			reject: deliveries.reject,
		};

		this.#listeners.get(caller)?.reject(new Error("A newer answers request of the same caller replaced this one"));
		this.#listeners.set(caller, listener);
		signal.addEventListener(
			"abort",
			() => {
				if (this.#listeners.get(caller) === listener) this.#listeners.delete(caller);
				// The host aborts with its reason when it closes.
				deliveries.reject(signal.reason instanceof Error ? signal.reason : new Error("The connection closed"));
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

	/** Stops the sweeps, and wakes each `done()` that waits for one, which then throws. */
	close(): void {
		this.#closed = true;
		this.#passes.stop();
		this.#observation.detach();
		clearTimeout(this.#retry);
		const ends = [...this.#sweepEnds];
		this.#sweepEnds.clear();

		for (const end of ends) end();
	}

	/**
	 * Sweeps, sets the timer of the next retry, and calls the functions that wait for the end of the sweep. The sweep and
	 * the timer use one reading of the clock, so each child that the sweep skips after a failed push gets a timer.
	 */
	async #pass(): Promise<void> {
		const now = Date.now();
		await this.#sweep(now).catch(this.#warn);
		this.#setRetry(now);
		const ends = [...this.#sweepEnds];
		this.#sweepEnds.clear();

		for (const end of ends) end();
	}

	/**
	 * Pushes the answers of the children that are done, oldest child first, then the user answers, oldest first, for each
	 * caller with a destination.
	 */
	async #sweep(now: number): Promise<void> {
		const state = await this.#host.harness.snapshot(ChildRecords, context);
		const entries: Entry[] = recordsByAge(state);
		const queued = await readUserAnswers(this.#host.harness, context);
		const keys = new Set([...Object.keys(state?.children ?? {}), ...queued.map(({ id }) => userAnswerRequest(id))]);

		for (const key of this.#failures.keys()) {
			if (!keys.has(key)) this.#failures.delete(key);
		}

		// The callers with a delivery that waits after a failed push: their later deliveries wait too, to keep the order.
		const blocked = new Set<string>();
		const done = new Map<string, Entry[]>();

		for (const entry of entries) {
			const [handle, record] = entry;

			if (!unreadNotify(record) || this.#waits(handle, record.caller, blocked, now)) continue;

			if (!this.#active.has(handle) && !this.#writing.has(handle) && !isHeld(state, record.conversationId))
				done.set(record.caller, [...(done.get(record.caller) ?? []), entry]);
		}

		const asked = new Map<string, UserAnswer[]>();

		for (const answer of queued) {
			const key = userAnswerRequest(answer.id);

			if (this.#waits(key, answer.asker, blocked, now) || this.#writing.has(key)) continue;
			asked.set(answer.asker, [...(asked.get(answer.asker) ?? []), answer]);
		}

		for (const caller of new Set([...done.keys(), ...asked.keys()])) {
			const children = done.get(caller) ?? [];
			const answers = asked.get(caller) ?? [];
			let destination: Destination | undefined;

			try {
				destination = await this.#destination(caller, entries);
			} catch (cause) {
				this.#fail([...children.map(([handle]) => handle), ...answers.map(({ id }) => userAnswerRequest(id))], cause);

				continue;
			}

			if (destination === undefined) continue;
			const pending = await this.#pending(children, answers);

			if (pending.length > 0) await this.#deliver(caller, destination, pending);
		}
	}

	/**
	 * Whether the delivery `key` of `caller` waits at `now`: `caller` has an earlier delivery that waits after a failed
	 * push, or this one does, which then holds the later deliveries of `caller` in `blocked`.
	 */
	#waits(key: string, caller: string, blocked: Set<string>, now: number): boolean {
		if ((this.#failures.get(key)?.retryAt ?? 0) > now) blocked.add(caller);

		return blocked.has(caller);
	}

	/**
	 * The deliveries of `children`, oldest child first, then of the user answers `answers`. It stops at the first child
	 * whose answers cannot be taken, so the later deliveries of the caller keep their order.
	 */
	async #pending(children: readonly Entry[], answers: readonly UserAnswer[]): Promise<Pending[]> {
		const pending: Pending[] = [];

		for (const [handle, record] of children) {
			let one: Pending | undefined;

			try {
				one = await this.#take(handle, record);
			} catch (cause) {
				this.#fail([handle], cause);

				return pending;
			}

			if (one === undefined) this.#succeed(handle);
			else pending.push(one);
		}

		for (const { id, delivery } of answers) {
			const requestId = userAnswerRequest(id);
			const settle = () => removeUserAnswer(this.#host.harness, id, context);
			pending.push({ key: requestId, delivery, requestId, settle });
		}

		return pending;
	}

	/**
	 * Where the answers for `caller` go: its open `answers` request, else the input of a conversation of the host (a
	 * child, the project agent, or another conversation of the children library, such as a child of a task). Nothing for
	 * a closed conversation, or for another caller, such as a Pi session without an open request: its deliveries wait.
	 */
	async #destination(caller: string, entries: readonly Entry[]): Promise<Destination | undefined> {
		if (this.#listeners.has(caller)) return { kind: "reply" };
		const send = await this.#input(caller, entries);

		return send === undefined ? undefined : { kind: "input", send };
	}

	/**
	 * Delivers `pending` to `destination`, in order. In the reply of an `answers` request, each one settles once the
	 * reply is written. As input, each one settles after its send, and the first that fails stops the others.
	 */
	async #deliver(caller: string, destination: Destination, pending: readonly Pending[]): Promise<void> {
		switch (destination.kind) {
			case "reply":
				this.#reply(caller, pending);

				for (const { key } of pending) this.#succeed(key);

				return;
			case "input":
				for (const { key, delivery, requestId, settle } of pending) {
					// The caller is busy with the input before the child stops holding it, and a repeated push finds the first one.
					try {
						await destination.send({ type: "input", content: deliveryText(delivery), whenBusy: "followUp", requestId });
						await settle();
					} catch (cause) {
						this.#fail([key], cause);

						// The later deliveries of this caller wait until this one is pushed, so they keep their order.
						return;
					}

					this.#succeed(key);
				}
		}
	}

	/** Forgets the failed pushes of the delivery `key`. */
	#succeed(key: string): void {
		this.#failures.delete(key);
	}

	/** Counts a failed push of each of the deliveries `keys`, and writes `cause` as a warning. */
	#fail(keys: readonly string[], cause: unknown): void {
		const now = Date.now();

		for (const key of keys) {
			const count = (this.#failures.get(key)?.count ?? 0) + 1;
			const wait = Math.min(FIRST_RETRY_MS * 2 ** (count - 1), MAX_RETRY_MS);
			this.#failures.set(key, { count, retryAt: now + wait });
		}

		this.#host.warn(cause);
	}

	/**
	 * Sets the timer of a sweep at the earliest wait of `#failures` that had not ended at `now`, the time of the last
	 * sweep, in place of the last timer.
	 */
	#setRetry(now: number): void {
		clearTimeout(this.#retry);
		this.#retry = undefined;
		const next = Math.min(...[...this.#failures.values()].flatMap(({ retryAt }) => (retryAt > now ? [retryAt] : [])));

		if (!Number.isFinite(next) || this.#closed) return;
		this.#retry = setTimeout(() => this.schedule(), Math.max(0, next - Date.now()));
		// The timer alone does not keep the host running.
		this.#retry.unref();
	}

	/**
	 * The input of `caller` when it is a conversation of the host that is not closed: a child, the project agent, or
	 * another conversation of the children library. Nothing for another caller, such as a Pi session.
	 */
	async inputOf(caller: string): Promise<((input: Input) => Promise<void>) | undefined> {
		return this.#input(caller, recordsByAge(await this.#host.harness.snapshot(ChildRecords, context)));
	}

	/** The input of `caller` when it is a conversation of the host that is not closed. */
	async #input(caller: string, entries: readonly Entry[]): Promise<((input: Input) => Promise<void>) | undefined> {
		if (caller === String(this.#host.root.id)) return (await target(this.#host, { kind: "agent" })).send;
		const inspected = await library.inspect(this.#host.place, caller, context);

		if ((await inspected?.state(context)) === "closed") return undefined;
		const parent = conversationEntry(entries, caller);

		if (parent !== undefined) return (await childTarget(this.#host, ...parent)).send;
		const conversation = inspected?.conversation;

		if (conversation === undefined) return undefined;

		return async (input) => {
			await conversation.submit(input, context);
		};
	}

	/** Replies to the open `answers` request of `caller` with `pending`, which settles once the reply is written. */
	#reply(caller: string, pending: readonly Pending[]): void {
		const listener = this.#listeners.get(caller);

		if (listener === undefined) return;
		this.#listeners.delete(caller);

		const settled = listener.written.then(async (ok) => {
			if (!ok) return;

			for (const { settle } of pending) await settle().catch(this.#warn);
		});

		for (const { key } of pending) {
			const done: Promise<void> = settled.finally(() => {
				if (this.#writing.get(key) === done) this.#writing.delete(key);
				this.schedule();
			});

			this.#writing.set(key, done);
		}

		listener.resolve(pending.map(({ delivery }) => delivery));
	}

	/**
	 * The unread answers of `handle` once its turn ended, as `wait` gives them; nothing when no answer is new. Input from
	 * a mirror session sends nothing up: its turn is not the main request, the caller's last request is.
	 */
	async #take(handle: string, record: ChildRecord): Promise<Pending | undefined> {
		const child = await childOf(this.#host, record);
		const state = await child.state(context);

		if (state === "busy" || state === "closed") return undefined;
		const last = await child.lastRequest(context);
		const ids = record.requests.map((request) => request.id);

		if (last === null) return undefined;
		const main = ids.includes(last) || isPushRequest(last) ? last : ids.at(-1);

		if (main === undefined) return undefined;
		const answer = await child.settled(context, main);
		const { text, failed, read } = await unreadAnswers(child, handle, record, main, answer, record.requests, context);

		if (read <= record.read) return undefined;

		const delivery: Delivery =
			record.name === undefined
				? { source: "child", handle, text, failed }
				: { source: "child", handle, name: record.name, text, failed };

		return {
			key: handle,
			delivery,
			requestId: pushRequest(handle, read),
			settle: () => markRead(this.#host.harness, handle, read, main),
		};
	}
}

/**
 * The request ID of the input of the user answer `id`. A repeated push has the same one, which the conversation takes
 * once.
 */
function userAnswerRequest(id: number): string {
	return `user-answer:${id}`;
}

/**
 * Whether `change` can end a turn or change a record: a live document without a run or retired, the `ChildRecords`
 * document, or the queue of the user answers.
 */
function endsTurn(change: CommitChange): boolean {
	if (change.type !== "document") return false;

	if (change.record.kind === ChildRecords.definition.kind || change.record.kind === USER_ANSWERS_KIND) return true;

	if (change.record.kind !== LiveDoc.definition.kind) return false;

	return change.kind === "retire" || change.value.run === undefined;
}
