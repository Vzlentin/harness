/**
 * The import of a store file into `project.sqlite`: the open of the project store, which imports `store.json` at the
 * first start of a host that has no `project.sqlite`, and refuses an old `durable.sqlite` with the lists of the project
 * and no `store.json`. The import creates `project.sqlite` only once its write commits.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import type { EntryAsks } from "../host/entries.ts";
import { ITEM_KIND } from "../protocol/item.ts";
import { type Ask, HELD_KIND, PARLEYS_KIND, PERSONS_KIND, RULES_KIND, THREADS_KIND } from "../protocol/project.ts";
import { parseStoreFile, type StoreFile } from "../protocol/store-file.ts";
import { PROJECT_STORE_FILE, ProjectStore } from "./project-store.ts";

const context = BACKGROUND_CONTEXT;

/** The file that the import writes, which becomes `project.sqlite` after its commit. */
const IMPORT_FILE = `${PROJECT_STORE_FILE}.import`;

/** The files that SQLite keeps beside a database file. */
const SIDE_FILES = ["", "-wal", "-shm", "-journal"];

/** The kinds of the documents of `durable.sqlite` in which an older host kept the lists of the project. */
const OLD_KINDS = [PERSONS_KIND, THREADS_KIND, RULES_KIND, HELD_KIND, PARLEYS_KIND, ITEM_KIND];

/** What the open of the project store uses of the host. */
export type ProjectStoreHost = {
	/** The state directory of the project. */
	readonly dir: string;
	/** `store.json` in the state directory. */
	readonly file: string;
	readonly harness: Harness;
	/** The storage of `harness`, whose scan finds the documents of an older host. */
	readonly storage: Pick<Storage, "scanDocuments">;
	readonly asks: Pick<EntryAsks, "read">;
};

/**
 * Opens `project.sqlite` in the state directory. When it is not there, it imports `store.json` first, and checks the
 * asks of its parleys against `durable.sqlite`. With no `store.json`, an old `durable.sqlite` with the lists of the
 * project fails, and else the store opens empty.
 */
export async function openProjectStore(host: ProjectStoreHost): Promise<ProjectStore> {
	const { dir, file, harness, storage, asks } = host;

	if (!existsSync(join(dir, PROJECT_STORE_FILE))) {
		if (existsSync(file)) {
			await importStoreFile(dir, parseStoreFile(file), async () => (await asks.read(harness, context)).asks);
		} else if (await hasOldLists(storage)) {
			throw new Error(
				`${dir} has the lists of the project in durable.sqlite but no store.json: write a store file with an older harness, then run harness store load`,
			);
		}
	}

	// The host is the only writer, so a write never waits for a lock.
	return ProjectStore.open(dir, 0);
}

/**
 * Writes `file` into `store`, with the IDs of the file. `durable` runs inside the write, and gives the asks of
 * `durable.sqlite`: each ask of the file whose parley is in the file must be there, with the same ID and parley. A
 * failure rolls `store` back.
 */
export async function loadStoreFile(
	store: ProjectStore,
	file: StoreFile,
	durable: () => Promise<readonly Ask[]>,
): Promise<void> {
	await store.load(file, async () => checkAsks(file, await durable()));
}

/**
 * Writes `file` into a new `project.sqlite` in `dir`, which has none, with `loadStoreFile`. The file becomes
 * `project.sqlite` only after the commit. A failure leaves no `project.sqlite`.
 */
export async function importStoreFile(
	dir: string,
	file: StoreFile,
	durable: () => Promise<readonly Ask[]>,
): Promise<void> {
	removeDatabase(join(dir, IMPORT_FILE));

	try {
		const store = ProjectStore.open(dir, 0, IMPORT_FILE);

		try {
			await loadStoreFile(store, file, durable);
		} finally {
			store.close();
		}

		renameSync(join(dir, IMPORT_FILE), join(dir, PROJECT_STORE_FILE));
	} catch (error) {
		removeDatabase(join(dir, IMPORT_FILE));
		throw error;
	}
}

/** Fails when an ask of a parley of `file` is not in `asks` with the same ID and parley. */
function checkAsks(file: StoreFile, asks: readonly Ask[]): void {
	const slugs = new Map(file.parleys.map((parley) => [parley.id, parley.slug]));
	const kept = new Map(asks.map((ask) => [ask.id, ask.parley?.id]));

	for (const ask of file.asks) {
		if (ask.parley === undefined) continue;
		const slug = slugs.get(ask.parley.id);

		if (slug === undefined) continue;

		if (kept.get(ask.id) !== ask.parley.id) {
			throw new Error(`The ask ${ask.id} of the parley ${slug} is not in durable.sqlite`);
		}
	}
}

/** Whether `storage` has a document of a kind in which an older host kept the lists of the project. */
async function hasOldLists(storage: Pick<Storage, "scanDocuments">): Promise<boolean> {
	for (const kind of OLD_KINDS) {
		const page = await storage.scanDocuments(
			{ scope: { kind: "session" }, at: "current", kind },
			1,
			undefined,
			context,
		);

		if (page.items.length > 0) return true;
	}

	return false;
}

/** Removes the database `path` and the files that SQLite keeps beside it. */
function removeDatabase(path: string): void {
	for (const suffix of SIDE_FILES) rmSync(`${path}${suffix}`, { force: true });
}
