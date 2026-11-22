/**
 * `harness store load <file>`: writes the lists and the items of a store file into the empty store of a project, while
 * no host runs.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type Storage, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { EntryHandles } from "../host/entries.ts";
import { takeLock } from "../host/lock.ts";
import { statePaths } from "../protocol/paths.ts";
import { STORE_LOCK_WAIT_MS } from "../protocol/requests.ts";
import { parseStoreFile, type StoreCounts, storeCounts, type StoreFile } from "../protocol/store-file.ts";
import { loadItems } from "./items.ts";
import { loadLists } from "./project.ts";
import { readStoreFile } from "./store-file.ts";

const context = BACKGROUND_CONTEXT;

/** What the load uses of the host: the asks and the lists of todos of the store, which need no open host. */
export type StoreLoadHandles = Pick<EntryHandles, "asks" | "todos">;

/**
 * Writes the lists of the store file at `path` into the store of `project` in one commit, under the lock of the host,
 * with the asks and the lists of todos of `handles`, and gives the count of each list. It fails before it writes when the file is not a store file, when a host runs for
 * `project`, or when a list of the store is not empty.
 */
export async function loadStore(project: string, path: string, handles: StoreLoadHandles): Promise<StoreCounts> {
	const file = parseStoreFile(path);
	const { dir } = statePaths(project);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = takeLock(dir);

	if (lock === undefined) {
		throw new Error(`A harness host runs for ${project}: stop it, then run harness store load again`);
	}

	try {
		const store = join(dir, "durable.sqlite");

		// A read-only open recovers nothing, so a store that is not empty stays as it is.
		const lists = await withHarness(store, true, (harness, storage) =>
			readStoreFile(harness, storage, ROOT_CONVERSATION_ID, handles),
		);

		if (Object.values(storeCounts(lists)).some((count) => count > 0)) {
			throw new Error(`The store of ${project} is not empty: harness store load writes only into an empty store`);
		}

		await withHarness(store, false, (harness) => writeFile(harness, handles, file));

		return storeCounts(file);
	} finally {
		lock.close();
	}
}

/**
 * Writes `file` in one commit, with the asks and the lists of todos of `handles`: the commit that creates the root conversation when the store has none. The commit always
 * writes the counter of the IDs of items, so the next start of a host does not move the loaded todos to items.
 */
async function writeFile(harness: Harness, handles: StoreLoadHandles, file: StoreFile): Promise<void> {
	const write = async (tx: Tx) => {
		await loadLists(tx, handles.asks, file);
		await handles.todos.load(tx, ROOT_CONVERSATION_ID, file.todos, file.callerTodos);
		await loadItems(tx, file.items, file.lastItem);
	};

	if ((await harness.conversation(ROOT_CONVERSATION_ID, context)) === undefined) {
		await harness.root(context, { init: write });
	} else {
		await harness.commit(write, context);
	}
}

/** Runs `use` on the harness of the store at `path`, and closes it. */
async function withHarness<T>(
	path: string,
	readOnly: boolean,
	use: (harness: Harness, storage: Storage) => Promise<T>,
): Promise<T> {
	const storage = await openNodeSqliteStorage(path, { busyTimeoutMs: STORE_LOCK_WAIT_MS });

	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry: createRegistry(), readOnly },
		context,
	);

	try {
		return await use(harness, storage);
	} finally {
		await harness.close(context);
	}
}
