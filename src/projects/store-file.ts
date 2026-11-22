/**
 * `store.json`: the host writes the lists and the items of the store of the project to it at its start, and after each
 * commit and each write of the project store that changes one, so a program can read them with no host and no store.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, Storage } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { EntryAsks, EntryTodos } from "../host/entries.ts";
import { CommitPasses } from "../host/passes.ts";
import { writeJsonFile } from "../protocol/json-file.ts";
import { errorMessage } from "../protocol/requests.ts";
import { STORE_FILE_VERSION, type StoreFile } from "../protocol/store-file.ts";
import { allItems, ItemCounterDoc, itemChange } from "./item-docs.ts";
import { readParleys } from "./parleys.ts";
import type { ProjectStore, StoreReader } from "./project-store.ts";
import { projectChange } from "./project.ts";

const context = BACKGROUND_CONTEXT;

/** What the file uses of the lists of todos. */
type StoreFileTodos = Pick<EntryTodos, "read" | "callers" | "changed">;

/** What the file uses of the host. */
export type StoreFileHost = {
	readonly harness: Harness;
	/** The storage of `harness`, whose scan lists the items and the callers that have a list of todos. */
	readonly storage: Pick<Storage, "scanDocuments">;
	/** The project store, with the persons, the threads, the messages, the rules and the held actions. */
	readonly store: Pick<ProjectStore, keyof StoreReader | "subscribe">;
	/** The root conversation, whose list is the list of the project. */
	readonly root: Conversation;
	readonly asks: Pick<EntryAsks, "read">;
	readonly todos: StoreFileTodos;
	/** The file, `store.json` in the state folder of the project. */
	readonly path: string;
	readonly warn: (cause: unknown) => void;
};

/** The passes that write the file. */
export type StoreFilePasses = {
	/** Stops the passes, and waits for the write in progress. */
	close(): Promise<void>;
};

/**
 * The passes that write the file at once, and again after each commit and each write of the project store that changes
 * a list. A write that fails gives one warning and does not fail the commit. `close()` stops the passes and waits for
 * the write in progress.
 */
export function storeFilePasses(host: StoreFileHost): StoreFilePasses {
	const passes = new CommitPasses(
		host.harness,
		(change) => projectChange(change) || host.todos.changed(change, host.root.id) || itemChange(change),
		() =>
			readStoreFile(host.harness, host.storage, host.root.id, host)
				.then((file) => writeJsonFile(host.path, file))
				.catch((cause: unknown) => host.warn(`Could not write ${host.path}: ${errorMessage(cause)}`)),
	);

	// The listener only requests a pass: it must not call the store.
	const unsubscribe = host.store.subscribe(() => passes.request());

	return {
		close: async () => {
			unsubscribe();
			await passes.close();
		},
	};
}

/**
 * Every list of the file, as the store of `harness` and the project store `store` have them now, with the list of
 * the project from the root conversation `root`, the asks from `asks` and the lists of todos from `todos`. `storage`,
 * the storage of `harness`, lists the items and the callers that have a list of todos. A store with no counter of the
 * IDs of items has `lastItem` 0.
 */
export async function readStoreFile(
	harness: Harness,
	storage: Pick<Storage, "scanDocuments">,
	root: ConversationId,
	{
		store,
		asks,
		todos: lists,
	}: {
		readonly store: Pick<StoreReader, keyof StoreReader>;
		readonly asks: Pick<EntryAsks, "read">;
		readonly todos: Pick<StoreFileTodos, "read" | "callers">;
	},
): Promise<StoreFile> {
	const [parleys, asked] = await Promise.all([readParleys(harness, context), asks.read(harness, context)]);

	const todos = await lists.read(harness, root, context);
	const callerTodos = await lists.callers(harness, storage, context);
	const items = await allItems(harness, storage, context);
	const counter = await harness.snapshot(ItemCounterDoc, context);

	return {
		version: STORE_FILE_VERSION,
		persons: store.persons(),
		threads: store.threads().map((thread) => ({ ...thread, messages: store.messages(thread.id) })),
		rules: store.rules({}),
		lastRule: store.lastRule(),
		held: store.held(),
		parleys: parleys.parleys,
		asks: asked.asks,
		todos: todos.todos,
		callerTodos,
		items: items.map((item) => Value.Clone(item)),
		lastItem: counter?.last ?? 0,
	};
}
