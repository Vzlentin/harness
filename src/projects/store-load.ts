/**
 * `harness store load <file>`: writes the lists and the items of a store file into the empty stores of a project
 * (`durable.sqlite` and `project.sqlite`), while no host runs, with the import of the first start of a host.
 */
import { existsSync, mkdirSync } from "node:fs";
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
import { PROJECT_STORE_FILE, ProjectStore } from "./project-store.ts";
import { readStoreFile } from "./store-file.ts";
import { importStoreFile, loadStoreFile } from "./store-import.ts";

const context = BACKGROUND_CONTEXT;

/** What the load uses of the host: the asks and the lists of todos of the store, which need no open host. */
export type StoreLoadHandles = Pick<EntryHandles, "asks" | "todos">;

/**
 * Writes the lists of the store file at `path` into the stores of `project`, under the lock of the host, with the asks
 * and the lists of todos of `handles`, and gives the count of each list. The persons, the threads, the messages, the
 * rules, the parleys and the items keep the IDs of the file. The two stores are written as one: the write into
 * `project.sqlite` stays open across the commit of `durable.sqlite`, and a commit that fails rolls it back, or leaves no
 * `project.sqlite` when there was none. It fails before it writes when the file is not a store file, when a host runs
 * for `project`, or when a list of the stores is not empty. An empty `project.sqlite` keeps its ID counters and its
 * deliveries.
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
		const durable = join(dir, "durable.sqlite");

		const writeDurable = () =>
			withHarness(durable, false, async (harness) => {
				await writeFile(harness, handles, file);

				return (await handles.asks.read(harness, context)).asks;
			});

		// The check opens `project.sqlite` only when it exists, so a failed load leaves none.
		const store = existsSync(join(dir, PROJECT_STORE_FILE)) ? ProjectStore.open(dir, STORE_LOCK_WAIT_MS) : undefined;

		try {
			// A read-only open recovers nothing, so a store that is not empty stays as it is.
			const lists = await withHarness(durable, true, (harness, storage) =>
				readStoreFile(harness, storage, ROOT_CONVERSATION_ID, { ...handles, store }),
			);

			if (Object.values(storeCounts(lists)).some((count) => count > 0)) {
				throw new Error(`The store of ${project} is not empty: harness store load writes only into an empty store`);
			}

			if (store === undefined) {
				await importStoreFile(dir, file, writeDurable);
			} else {
				await loadStoreFile(store, file, writeDurable);
			}
		} finally {
			store?.close();
		}

		return storeCounts(file);
	} finally {
		lock.close();
	}
}

/**
 * Writes the lists of `file` that `durable.sqlite` keeps, the asks and the lists of todos, in one commit with the
 * handles `handles`: the commit that creates the root conversation when the store has none.
 */
async function writeFile(harness: Harness, handles: StoreLoadHandles, file: StoreFile): Promise<void> {
	const write = async (tx: Tx) => {
		await handles.asks.load(tx, file.asks);
		await handles.todos.load(tx, ROOT_CONVERSATION_ID, file.todos, file.callerTodos);
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
