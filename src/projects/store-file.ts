/** The lists and the items of the two stores of a project as a store file, which `store load` reads to check that they are empty. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Storage } from "@earendil-works/pi-durable";
import type { EntryAsks, EntryTodos } from "../host/entries.ts";
import { STORE_FILE_VERSION, type StoreFile } from "../protocol/store-file.ts";
import type { StoreReader } from "./project-store.ts";

const context = BACKGROUND_CONTEXT;

/** The lists of a store file that `project.sqlite` keeps. */
type ProjectLists = Omit<StoreFile, "version" | "asks" | "todos" | "callerTodos">;

/** The lists of a project with no `project.sqlite`. */
const NO_PROJECT_LISTS: ProjectLists = {
	persons: [],
	threads: [],
	rules: [],
	lastRule: 0,
	held: [],
	parleys: [],
	items: [],
	lastItem: 0,
};

/**
 * Every list of the file, as the store of `harness` and the project store `store` have them now, with the list of
 * the project from the root conversation `root`, the asks from `asks` and the lists of todos from `todos`. `storage`,
 * the storage of `harness`, lists the callers that have a list of todos. With no `store`, the lists of `project.sqlite`
 * are empty. A store with no counter of the IDs of items has `lastItem` 0.
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
		readonly store: Pick<StoreReader, keyof StoreReader> | undefined;
		readonly asks: Pick<EntryAsks, "read">;
		readonly todos: Pick<EntryTodos, "read" | "callers">;
	},
): Promise<StoreFile> {
	const asked = await asks.read(harness, context);
	const todos = await lists.read(harness, root, context);
	const callerTodos = await lists.callers(harness, storage, context);

	return {
		version: STORE_FILE_VERSION,
		...(store === undefined ? NO_PROJECT_LISTS : projectLists(store)),
		asks: asked.asks,
		todos: todos.todos,
		callerTodos,
	};
}

/** The lists of `store`. */
function projectLists(store: Pick<StoreReader, keyof StoreReader>): ProjectLists {
	return {
		persons: store.persons(),
		threads: store.threads().map((thread) => ({ ...thread, messages: store.messages(thread.id) })),
		rules: store.rules({}),
		lastRule: store.lastRule(),
		held: store.held(),
		parleys: store.parleys(),
		items: store.items(),
		lastItem: store.lastItem() ?? 0,
	};
}
