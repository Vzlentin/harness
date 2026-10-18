/**
 * The entries that the host loads: the `piDurable` entries of Pi's packages and the entries of `entries.json`. Each
 * entry is a module whose default export gives extensions and tasks to the host.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as ai from "@earendil-works/pi-ai";
import {
	createEventBus,
	DefaultPackageManager,
	type EventBus,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AnyTask, Extension } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { createChildren, Place } from "./children.ts";
import { readEntries } from "./entries.ts";

type ChildrenLibrary = ReturnType<typeof createChildren>;

/** What the default export of an entry returns: its extensions, the tasks that `start` runs, and `close`. */
export type Entry = {
	readonly extensions: readonly Extension[];
	readonly tasks?: readonly AnyTask[];
	close(): Promise<void>;
};

/** What the host gives the default export of an entry. */
type EntryOptions = {
	readonly durable: typeof durable;
	readonly ai: typeof ai;
	readonly events: EventBus;
	readonly children: ChildrenLibrary;
	readonly place: Place;
};

/** A `package.json`, which is a JSON object. */
const PackageJson = Type.Object({});

/** The part of a package's `package.json` that names its entries. */
const Manifest = Type.Object({
	piDurable: Type.Optional(Type.Object({ extensions: Type.Optional(Type.Array(Type.String())) })),
});

/**
 * The `piDurable` entries of the installed packages in Pi's `settingsManager` for `cwd`, then the entries of
 * `entries.json` (see `readEntries`), with the children library `children`, in one shared event bus, as one entry whose `close()` closes each of them and
 * passes its errors to `warn`. When an entry fails to load, the entries loaded before it close. Missing packages are
 * skipped, not installed, and so is an entry module that does not exist, such as one of an uninstalled package.
 */
export async function loadEntries(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	place: Place,
	children: ChildrenLibrary,
	warn: (cause: unknown) => void,
): Promise<Required<Entry>> {
	const modules = new Set<string>();

	const roots = new DefaultPackageManager({ cwd, agentDir, settingsManager })
		.listConfiguredPackages()
		.flatMap((found) => found.installedPath ?? []);

	for (const root of new Set(roots)) {
		const path = join(root, "package.json");
		const manifest: unknown = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));

		if (!Value.Check(PackageJson, manifest)) {
			warn(new Error(`${path} is not a valid package.json`));
			continue;
		}

		if (!Value.Check(Manifest, manifest)) {
			warn(new Error(`${path} has an invalid piDurable field`));
			continue;
		}

		for (const path of manifest.piDurable?.extensions ?? []) modules.add(resolvePath(root, path));
	}

	for (const module of Object.values(readEntries())) if (existsSync(module)) modules.add(module);
	const events = createEventBus();
	const entries: Entry[] = [];

	const close = async () => {
		for (const result of await Promise.allSettled(entries.map((entry) => entry.close()))) {
			if (result.status === "rejected") warn(result.reason);
		}
	};

	try {
		for (const module of modules) {
			const entry = await importEntry(module);
			entries.push(await entry.default({ durable, ai, events, children, place }));
		}
	} catch (error) {
		await close();
		throw error;
	}

	return {
		extensions: entries.flatMap((entry) => entry.extensions),
		tasks: entries.flatMap((entry) => entry.tasks ?? []),
		close,
	};
}

/**
 * Imports the entry `module`. Node does not strip types under `node_modules`, where Pi installs npm packages, so jiti
 * loads a TypeScript entry there.
 */
async function importEntry(module: string): Promise<{ default: (options: EntryOptions) => Entry | Promise<Entry> }> {
	if (module.endsWith(".ts") && module.split(sep).includes("node_modules")) {
		const { createJiti } = await import("jiti");

		return createJiti(import.meta.url).import(module);
	}

	return import(pathToFileURL(module).href);
}
