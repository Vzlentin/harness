/**
 * The watch of the store of a project: the persons, rules, threads with their waits, held actions, parleys and asks,
 * then an event with the objects that changed and the IDs of those that went, after the commits that change them.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitChange, Harness, Storage } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { isWaiting, type ProjectEvent, type ProjectState, type ProjectThread } from "../protocol/project.ts";
import type { Replies } from "../protocol/requests.ts";
import type { Degraded } from "./degraded.ts";
import { readRules } from "./project-rules.ts";
import {
	joinMessage,
	outStates,
	projectChange,
	readAsks,
	readHeld,
	readOutbox,
	readParleys,
	readPersons,
	readStored,
	readThreads,
	type StoredMessage,
} from "./project.ts";
import type { Connection } from "./push.ts";
import { type StoreView, serveStoreWatch } from "./store-watch.ts";

const context = BACKGROUND_CONTEXT;

export type ProjectHost = {
	readonly harness: Harness;
	/** The storage of `harness`, whose entry lookup gives the thread of the source of an older rule. */
	readonly storage: Pick<Storage, "entry">;
	readonly degraded: Degraded;
};

/**
 * Opens a watch of the store of the project on `connection`, and returns the reply, with every object. A pass runs once
 * the reply is written, and after it each commit that changes a person, a rule, a thread, a message, a held action,
 * a parley or an ask starts a pass, and so does each change of the degraded states of the host: the host reads the
 * objects again and sends one `{ event: ProjectEvent }` with the objects that are new or changed, the IDs of those that
 * went and every degraded state, only when one of its lists is not empty or the degraded states changed. The passes run
 * one at a time, and the commits during a pass give one more pass. When a write waits for a slow socket to drain, the
 * next event has every object. A pass that fails, and the close of the store, end the connection. The watch stops when the socket
 * closes.
 */
export function serveProjectWatch(
	handler: ProjectHost & { readonly signal: AbortSignal },
	connection: Connection,
): Promise<Replies["watch-project"]> {
	return serveStoreWatch(handler.harness, new ProjectView(handler), handler.signal, connection);
}

/**
 * The event from `before` to `after`: the objects of `after` that `before` does not have the same, every object of
 * `after` when `all` is true, and the IDs of the objects of `before` that `after` does not have. It is `undefined` when
 * all its lists are empty and the degraded states of `before` and `after` are equal. It has every degraded state of
 * `after`.
 */
export function projectEvent(before: ProjectState, after: ProjectState, all: boolean): ProjectEvent | undefined {
	const event: ProjectEvent = {
		persons: changed(before.persons, after.persons, all),
		rules: changed(before.rules, after.rules, all),
		threads: changed(before.threads, after.threads, all),
		held: changed(before.held, after.held, all),
		parleys: changed(before.parleys, after.parleys, all),
		asks: changed(before.asks, after.asks, all),
		removed: {
			persons: removed(before.persons, after.persons),
			rules: removed(before.rules, after.rules),
			threads: removed(before.threads, after.threads),
			held: removed(before.held, after.held),
			parleys: removed(before.parleys, after.parleys),
			asks: removed(before.asks, after.asks),
		},
		degraded: after.degraded,
	};

	const lists = [
		event.persons,
		event.rules,
		event.threads,
		event.held,
		event.parleys,
		event.asks,
		...Object.values(event.removed),
	];

	const changes = lists.some((list) => list.length > 0) || !Value.Equal(before.degraded, after.degraded);

	return changes ? event : undefined;
}

/** The objects of the project and the degraded states of the host, and the commits that can change them. */
class ProjectView implements StoreView<ProjectState, ProjectEvent> {
	readonly #host: ProjectHost;
	/** The IDs of the threads that got a message since the last read, whose messages the next read reads again. */
	#fresh = new Set<number>();
	/** The messages out of each thread, by thread ID, as the last read read them, with no state. */
	#out = new Map<number, StoredMessage[]>();

	constructor(host: ProjectHost) {
		this.#host = host;
	}

	/**
	 * Reads every object. It reads the messages only of the threads that are new since the last read or got a message
	 * since then; the other threads keep the messages of the last read. The states come from the outbox at each read.
	 */
	async read(): Promise<ProjectState> {
		const fresh = this.#fresh;
		this.#fresh = new Set();

		const [persons, rules, threads, held, parleys, asks] = await Promise.all([
			readPersons(this.#host.harness, context),
			readRules(this.#host, {}, context),
			readThreads(this.#host.harness, context),
			readHeld(this.#host.harness, context),
			readParleys(this.#host.harness, context),
			readAsks(this.#host.harness, context),
		]);

		const out = new Map(
			await Promise.all(
				threads.threads.map(async (thread): Promise<[number, StoredMessage[]]> => {
					const known = fresh.has(thread.id) ? undefined : this.#out.get(thread.id);
					const messages = known ?? (await readStored(this.#host.harness, thread.id, context));

					return [thread.id, messages.filter((message) => message.direction === "out")];
				}),
			),
		);

		this.#out = out;
		// The outbox is read after the messages, so that each message out that they have has its state there.
		const states = outStates(await readOutbox(this.#host.harness, context));

		const withWaits: ProjectThread[] = threads.threads.map((thread) => ({
			...thread,
			waits: (out.get(thread.id) ?? []).flatMap((stored) => {
				const message = joinMessage(stored, states);

				return isWaiting(message.state) ? [message] : [];
			}),
		}));

		return {
			...persons,
			...rules,
			threads: withWaits,
			...held,
			...parleys,
			...asks,
			degraded: this.#host.degraded.list(),
		};
	}

	events(before: ProjectState, after: ProjectState, all: boolean): ProjectEvent[] {
		const event = projectEvent(before, after, all);

		return event === undefined ? [] : [event];
	}

	/** Whether `change` can change an object of the project. It records the threads that get a message. */
	changes(change: CommitChange): boolean {
		if (!projectChange(change)) return false;

		if (change.type === "entry") this.#fresh.add(change.value.conversationId);

		return true;
	}

	/** Requests a pass at each change of the degraded states. */
	triggers(request: () => void): () => void {
		return this.#host.degraded.subscribe(request);
	}
}

function changed<T extends { readonly id: number }>(before: readonly T[], after: readonly T[], all: boolean): T[] {
	if (all) return [...after];
	const texts = new Map(before.map((item) => [item.id, JSON.stringify(item)]));

	return after.filter((item) => texts.get(item.id) !== JSON.stringify(item));
}

function removed(before: readonly { readonly id: number }[], after: readonly { readonly id: number }[]): number[] {
	const ids = new Set(after.map((item) => item.id));

	return before.flatMap((item) => (ids.has(item.id) ? [] : [item.id]));
}
