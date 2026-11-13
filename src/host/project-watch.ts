/**
 * The watch of the store of a project: the persons, rules, terms, threads with their waits, parts and held actions,
 * then an event with the objects that changed and the IDs of those that went, after the commits that change them.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitChange, Harness } from "@earendil-works/pi-durable";
import {
	HELD_KIND,
	isWaiting,
	MESSAGE_KIND,
	OUTBOX_KIND,
	PARTS_KIND,
	PERSONS_KIND,
	type ProjectEvent,
	type ProjectState,
	type ProjectThread,
	RULES_KIND,
	TERMS_KIND,
	THREADS_KIND,
} from "../protocol/project.ts";
import type { Replies } from "../protocol/requests.ts";
import {
	joinMessage,
	outStates,
	readHeld,
	readOutbox,
	readParts,
	readPersons,
	readRules,
	readTerms,
	readStored,
	readThreads,
	type StoredMessage,
} from "./project.ts";
import type { Connection } from "./push.ts";
import { type StoreView, serveStoreWatch } from "./store-watch.ts";

const context = BACKGROUND_CONTEXT;

/** The kinds of the documents of the project. A message is an entry, not a document; its state out is in the outbox. */
const PROJECT_DOCS: ReadonlySet<string> = new Set([
	PERSONS_KIND,
	THREADS_KIND,
	RULES_KIND,
	TERMS_KIND,
	PARTS_KIND,
	HELD_KIND,
	OUTBOX_KIND,
]);

export type ProjectHost = { readonly harness: Harness };

/**
 * Opens a watch of the store of the project on `connection`, and returns the reply, with every object. A pass runs once
 * the reply is written, and after it each commit that changes a person, a rule, a term, a thread, a message, a part or
 * a held action starts a pass: the host reads the objects again and sends one `{ event: ProjectEvent }` with the objects
 * that are new or changed and the IDs of those that went, only when one of its lists is not empty. The passes run one at a time,
 * and the commits during a pass give one more pass. When a write waits for a slow socket to drain, the next event has
 * every object. A pass that fails, and the close of the store, end the connection. The watch stops when the socket
 * closes.
 */
export function serveProjectWatch(
	handler: ProjectHost & { readonly signal: AbortSignal },
	connection: Connection,
): Promise<Replies["watch-project"]> {
	return serveStoreWatch(handler.harness, new ProjectView(handler.harness), handler.signal, connection);
}

/**
 * The event from `before` to `after`: the objects of `after` that `before` does not have the same, every object of
 * `after` when `all` is true, and the IDs of the objects of `before` that `after` does not have. It is `undefined` when
 * all its lists are empty.
 */
export function projectEvent(before: ProjectState, after: ProjectState, all: boolean): ProjectEvent | undefined {
	const event: ProjectEvent = {
		persons: changed(before.persons, after.persons, all),
		rules: changed(before.rules, after.rules, all),
		terms: changed(before.terms, after.terms, all),
		threads: changed(before.threads, after.threads, all),
		parts: changed(before.parts, after.parts, all),
		held: changed(before.held, after.held, all),
		removed: {
			persons: removed(before.persons, after.persons),
			rules: removed(before.rules, after.rules),
			terms: removed(before.terms, after.terms),
			threads: removed(before.threads, after.threads),
			parts: removed(before.parts, after.parts),
			held: removed(before.held, after.held),
		},
	};

	const lists = [
		event.persons,
		event.rules,
		event.terms,
		event.threads,
		event.parts,
		event.held,
		...Object.values(event.removed),
	];

	return lists.some((list) => list.length > 0) ? event : undefined;
}

/** The objects of the project, and the commits that can change them. */
class ProjectView implements StoreView<ProjectState, ProjectEvent> {
	readonly #harness: Harness;
	/** The IDs of the threads that got a message since the last read, whose messages the next read reads again. */
	#fresh = new Set<number>();
	/** The messages out of each thread, by thread ID, as the last read read them, with no state. */
	#out = new Map<number, StoredMessage[]>();

	constructor(harness: Harness) {
		this.#harness = harness;
	}

	/**
	 * Reads every object. It reads the messages only of the threads that are new since the last read or got a message
	 * since then; the other threads keep the messages of the last read. The states come from the outbox at each read.
	 */
	async read(): Promise<ProjectState> {
		const fresh = this.#fresh;
		this.#fresh = new Set();

		const [persons, rules, terms, threads, parts, held] = await Promise.all([
			readPersons(this.#harness, context),
			readRules(this.#harness, {}, context),
			readTerms(this.#harness, context),
			readThreads(this.#harness, context),
			readParts(this.#harness, {}, context),
			readHeld(this.#harness, context),
		]);

		const out = new Map(
			await Promise.all(
				threads.threads.map(async (thread): Promise<[number, StoredMessage[]]> => {
					const known = fresh.has(thread.id) ? undefined : this.#out.get(thread.id);
					const messages = known ?? (await readStored(this.#harness, thread.id, context));

					return [thread.id, messages.filter((message) => message.direction === "out")];
				}),
			),
		);

		this.#out = out;
		// The outbox is read after the messages, so that each message out that they have has its state there.
		const states = outStates(await readOutbox(this.#harness, context));

		const withWaits: ProjectThread[] = threads.threads.map((thread) => ({
			...thread,
			waits: (out.get(thread.id) ?? []).flatMap((stored) => {
				const message = joinMessage(stored, states);

				return isWaiting(message.state) ? [message] : [];
			}),
		}));

		return { ...persons, ...rules, ...terms, threads: withWaits, ...parts, ...held };
	}

	events(before: ProjectState, after: ProjectState, all: boolean): ProjectEvent[] {
		const event = projectEvent(before, after, all);

		return event === undefined ? [] : [event];
	}

	/** Whether `change` can change an object of the project. It records the threads that get a message. */
	changes(change: CommitChange): boolean {
		switch (change.type) {
			case "entry":
				if (change.value.kind !== MESSAGE_KIND) return false;
				this.#fresh.add(change.value.conversationId);

				return true;
			case "document":
				return PROJECT_DOCS.has(change.record.kind);
			default:
				return false;
		}
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
