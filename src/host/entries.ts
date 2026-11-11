/**
 * The entries that the host loads: the `piDurable` entries of Pi's packages and the entries of `entries.json`. Each
 * entry is a module whose default export gives extensions, tasks and a catch-up hook to the host.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@earendil-works/chord/json";
import * as ai from "@earendil-works/pi-ai";
import {
	createEventBus,
	DefaultPackageManager,
	type EventBus,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AnyTask, Extension, Harness } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { createChildren, Place } from "../children/library.ts";
import { readEntries } from "../protocol/entries.ts";
import { Json } from "../protocol/requests.ts";

type ChildrenLibrary = ReturnType<typeof createChildren>;

/**
 * What a catch-up hook gives for one catch-up: `seen`, what the agent has seen now, which the next catch-up gives the
 * hook back; `lines`, the facts for the agent, none when nothing is new; and `data`, the same facts for the entry.
 */
export const CatchUpPart = Type.Object({
	seen: Json,
	lines: Type.Array(Type.String()),
	data: Type.Optional(Json),
});

export type CatchUpPart = Static<typeof CatchUpPart>;

/**
 * The catch-up hook of an entry. Before each input of the project agent, the host calls `run` with what the hook said
 * the agent saw at the last catch-up, or nothing the first time. `kind` names the hook's state and data. The hooks of
 * `loadEntries` check the part of `run`: an invalid part throws.
 */
const CatchUpHook = Type.Object({
	kind: Type.String({ minLength: 1 }),
	run: Type.Unsafe<(harness: Harness, seen: JsonValue | undefined) => Promise<CatchUpPart>>(
		Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()),
	),
});

export type CatchUpHook = Static<typeof CatchUpHook>;

/**
 * What the default export of an entry returns: its extensions, the tasks that `start` runs, its catch-up hook, and
 * `close`.
 */
const EntryResult = Type.Object({
	extensions: Type.Unsafe<readonly Extension[]>(Type.Array(Type.Unknown())),
	tasks: Type.Optional(Type.Unsafe<readonly AnyTask[]>(Type.Array(Type.Unknown()))),
	catchUp: Type.Optional(CatchUpHook),
	close: Type.Unsafe<() => Promise<void>>(Type.Function([], Type.Unknown())),
});

export type Entry = Static<typeof EntryResult>;

/**
 * The entries that the host loaded, as one: their extensions, tasks and catch-up hooks in load order, the event bus that
 * they share, and `close`.
 */
export type LoadedEntries = {
	readonly extensions: readonly Extension[];
	readonly tasks: readonly AnyTask[];
	readonly catchUps: readonly CatchUpHook[];
	readonly events: EventBus;
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
 * passes its errors to `warn`. When an entry fails to load, returns an invalid result, or gives the kind of catch-up
 * hook of an earlier entry, the entries loaded before it close. Missing packages are skipped, not installed, and so is
 * an entry module of `entries.json` that does not exist, such as one of an uninstalled package, with a warning.
 */
export async function loadEntries(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	place: Place,
	children: ChildrenLibrary,
	warn: (cause: unknown) => void,
): Promise<LoadedEntries> {
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

	for (const [name, module] of Object.entries(readEntries())) {
		if (existsSync(module)) modules.add(module);
		else warn(new Error(`The entry ${name} has no module at ${module}; the host skips it`));
	}

	const events = createEventBus();
	const entries: Entry[] = [];
	/** The module of each catch-up hook, by kind. */
	const hookModules = new Map<string, string>();

	const close = async () => {
		for (const result of await Promise.allSettled(entries.map((entry) => entry.close()))) {
			if (result.status === "rejected") warn(result.reason);
		}
	};

	try {
		for (const module of modules) {
			const entry = await importEntry(module);
			const result: unknown = await entry.default({ durable, ai, events, children, place });

			if (!Value.Check(EntryResult, result)) {
				throw new Error(
					`The entry ${module} returned an invalid result: ${invalidReason(Value.Errors(EntryResult, result))}`,
				);
			}

			entries.push(result);
			const kind = result.catchUp?.kind;

			if (kind === undefined) continue;
			const other = hookModules.get(kind);

			if (other !== undefined) {
				throw new Error(`The entries ${other} and ${module} both give the catch-up hook ${kind}`);
			}

			hookModules.set(kind, module);
		}
	} catch (error) {
		await close();
		throw error;
	}

	return {
		extensions: entries.flatMap((entry) => entry.extensions),
		tasks: entries.flatMap((entry) => entry.tasks ?? []),
		catchUps: entries.flatMap((entry) => (entry.catchUp === undefined ? [] : [checkedHook(entry.catchUp)])),
		events,
		close,
	};
}

/** The catch-up hook `hook`, whose `run` throws `invalid result: <path> <message>` for an invalid part. */
function checkedHook(hook: CatchUpHook): CatchUpHook {
	return {
		kind: hook.kind,
		run: async (harness, seen) => {
			const part: unknown = await hook.run(harness, seen);

			if (!Value.Check(CatchUpPart, part)) {
				throw new Error(`invalid result: ${invalidReason(Value.Errors(CatchUpPart, part))}`);
			}

			return part;
		},
	};
}

/** Why a value does not match its schema: the path and the message of its first error in `errors`. */
function invalidReason([error]: readonly TLocalizedValidationError[]): string {
	return [error?.instancePath, error?.message].filter((part) => part).join(" ");
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
