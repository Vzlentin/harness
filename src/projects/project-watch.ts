/**
 * The watch of the store of a project: the persons, rules, threads with their waits, held actions, parleys, asks and
 * open work items with their stages, then an event with the objects that changed and the IDs of those that went, after
 * the writes and the commits that change them.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import type { CommitChange, Harness, Storage } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { Degraded } from "../host/degraded.ts";
import type { EntryHandles, EntryWatchOptions } from "../host/entries.ts";
import { type StoreView, watchStore } from "../host/store-watch.ts";
import type { StagedItem, WorkItem } from "../protocol/item.ts";
import type { ProjectEvent, ProjectState } from "../protocol/project-watch.ts";
import { ASKS_KIND, HELD_KIND, isWaiting, PARLEYS_KIND, type ProjectThread } from "../protocol/project.ts";
import { changedItemId, readItem, readItems } from "./item-docs.ts";
import { type StageHost, stageItems } from "./item-stage.ts";
import { readParleys } from "./parleys.ts";
import { type ProjectStore, replyMessage } from "./project-store.ts";
import { projectChange, readHeld } from "./project.ts";

const context = BACKGROUND_CONTEXT;

/** The kinds of the documents whose changes can change the stage or `needsYou` of any item. */
const STAGE_DOCS: ReadonlySet<string> = new Set([PARLEYS_KIND, ASKS_KIND, HELD_KIND]);

/**
 * What the watch uses of the host. `workersChange` tells the changes that can change a worker of a label, and so the
 * stage or `needsYou` of any item.
 */
export type ProjectHost = StageHost &
	Pick<EntryHandles, "workersChange" | "asks"> & {
		readonly harness: Harness;
		/** The storage of `harness`, whose scan of documents lists the items. */
		readonly storage: Pick<Storage, "scanDocuments">;
		/** The project store, with the persons, the rules, the threads and the messages. */
		readonly store: Pick<ProjectStore, "persons" | "rules" | "threads" | "outMessages" | "subscribe">;
		readonly degraded: Degraded;
	};

/**
 * Opens a watch of the store of the project with the calls of the entry watch `options`, and returns the reply, with
 * every object. A pass runs at once, and its events wait for the reply. After it, each write of the project store that
 * changes a person, a rule, a thread or a message, each commit that changes a held action, a parley, an ask, an item, a
 * child, a started task or a task that ends, and each change of the degraded states of the host start a pass: the host reads the objects again and
 * sends one `{ event: ProjectEvent }` with the objects that are new or changed, the IDs of those that went and every
 * degraded state, only when one of its lists is not empty or the degraded states changed. The passes run one at a
 * time, and the commits during a pass give one more pass. When a write waits for a slow socket to drain, the next event
 * has every object. A pass that fails, and the close of the store, end the connection. The watch stops when the socket
 * closes.
 */
export async function serveProjectWatch(host: ProjectHost, options: EntryWatchOptions): Promise<JsonValue> {
	return json(
		await watchStore(host.harness, new ProjectView(host), {
			...options,
			emit: (event: ProjectEvent) => options.emit(json(event)),
		}),
	);
}

/** `value` as JSON, without its undefined properties. */
function json(value: ProjectState | ProjectEvent): JsonValue {
	return copyJson(value, { omitUndefinedProperties: true });
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
		items: changed(before.items, after.items, all),
		removed: {
			persons: removed(before.persons, after.persons),
			rules: removed(before.rules, after.rules),
			threads: removed(before.threads, after.threads),
			held: removed(before.held, after.held),
			parleys: removed(before.parleys, after.parleys),
			asks: removed(before.asks, after.asks),
			// No request retires an item: an item that leaves `open` comes once with its state, and then no more.
			items: [],
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
		event.items,
		...Object.values(event.removed),
	];

	const changes = lists.some((list) => list.length > 0) || !Value.Equal(before.degraded, after.degraded);

	return changes ? event : undefined;
}

/** The objects of the project and the degraded states of the host, and the commits that can change them. */
class ProjectView implements StoreView<ProjectState, ProjectEvent> {
	readonly #host: ProjectHost;
	/** The open items with their stages, by ID, as the last read gave them; nothing before the first read. */
	#staged: Map<number, StagedItem> | undefined;
	/** The IDs of the items that a commit changed since the last read, which the next read reads again. */
	#freshItems = new Set<number>();
	/**
	 * Whether a parley, an ask, a held action, a child, a started task or a task that ends changed since the last read, so it works out every stage
	 * again. The first read works out every stage.
	 */
	#allStages = true;

	constructor(host: ProjectHost) {
		this.#host = host;
	}

	/** Reads every object. */
	async read(): Promise<ProjectState> {
		const { store } = this.#host;
		const items = this.#readItems();

		const [held, parleys, asks] = await Promise.all([
			readHeld(this.#host.harness, context),
			readParleys(this.#host.harness, context),
			this.#host.asks.read(this.#host.harness, context),
		]);

		const waiting = store.outMessages().filter((message) => isWaiting(message.state));

		const threads: ProjectThread[] = store.threads().map((thread) => ({
			...thread,
			waits: waiting.filter((message) => message.thread === thread.id).map(replyMessage),
		}));

		return {
			persons: store.persons(),
			rules: store.rules({}),
			threads,
			...held,
			...parleys,
			...asks,
			items: await items,
			degraded: this.#host.degraded.list(),
		};
	}

	events(before: ProjectState, after: ProjectState, all: boolean): ProjectEvent[] {
		const event = projectEvent(before, after, all);

		return event === undefined ? [] : [event];
	}

	/**
	 * Whether `change` can change an object of the project in `durable.sqlite`. It records the items that change, and
	 * whether every stage can change.
	 */
	changes(change: CommitChange): boolean {
		const item = changedItemId(change);

		if (item !== undefined) {
			this.#freshItems.add(item);

			return true;
		}

		if (this.#host.workersChange(change)) {
			this.#allStages = true;

			return true;
		}

		if (!projectChange(change)) return false;

		if (change.type === "document" && STAGE_DOCS.has(change.record.kind)) this.#allStages = true;

		return true;
	}

	/**
	 * The open items with their stages, in ID order, and the items that left `open` since the last read, once. The first
	 * read lists the open items. A later read reads again the items that a commit changed, and works out the stages of
	 * those items, or of every open item after a change of a parley, an ask, a held action, a child, a started task or a task that ends.
	 */
	async #readItems(): Promise<StagedItem[]> {
		const fresh = this.#freshItems;
		const all = this.#allStages;
		this.#freshItems = new Set();
		this.#allStages = false;
		const map = this.#staged ?? new Map<number, StagedItem>();

		const read =
			this.#staged === undefined
				? await readItems(this.#host.harness, this.#host.storage, "open", context)
				: await Promise.all([...fresh].map((id) => readItem(this.#host.harness, id, context)));

		this.#staged = map;
		const open: WorkItem[] = [];
		const left: WorkItem[] = [];

		for (const item of read) {
			if (item.state === "open") open.push(item);
			else if (map.delete(item.id)) left.push(item);
		}

		const readIds = new Set(open.map((item) => item.id));
		const cached = [...map.values()].filter((item) => !readIds.has(item.id) && all);
		const again = [...open, ...cached, ...left];
		const staged = again.length === 0 ? [] : await stageItems(this.#host, again);
		const leftStaged: StagedItem[] = [];

		for (const item of staged) {
			if (item.state === "open") map.set(item.id, item);
			else leftStaged.push(item);
		}

		return [...map.values(), ...leftStaged].sort((a, b) => a.id - b.id);
	}

	/** Requests a pass at each change of the degraded states, and at each write of the project store that changes it. */
	triggers(request: () => void): () => void {
		const degraded = this.#host.degraded.subscribe(request);
		const store = this.#host.store.subscribe(request);

		return () => {
			degraded();
			store();
		};
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
