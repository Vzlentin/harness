/**
 * The entries that the host loads: the `piDurable` entries of Pi's packages and the entries of `entries.json`. Each
 * entry is a module whose default export gets the host's handles, and gives extensions, tasks, a catch-up hook, the
 * request types that it serves and the version of its protocol to the host.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@earendil-works/chord/json";
import * as ai from "@earendil-works/pi-ai";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import {
	createEventBus,
	DefaultPackageManager,
	type EventBus,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AnyTask, Extension, Harness } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { createChildren, Place } from "../children/library.ts";
import { readEntries } from "../protocol/entries.ts";
import type { AskList } from "../protocol/project.ts";
import { Json } from "../protocol/requests.ts";
import type { ClassifierKey } from "./classify.ts";
import type { Degraded } from "./degraded.ts";

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

/** A request line of a type that an entry serves: a JSON object with its type. */
export const EntryLine = Type.Intersect([Type.Object({ type: Type.String() }), Type.Record(Type.String(), Json)]);

export type EntryLine = Static<typeof EntryLine>;

/** What a watch of an entry gets: the signal of its connection, and the calls that send an event and end it. */
export type EntryWatchOptions = {
	/** Aborts when the socket or the host closes. */
	readonly signal: AbortSignal;
	/** Sends `event` as one `{ "event": ... }` line, after the reply. */
	readonly emit: (event: JsonValue) => void;
	/** Ends the connection, after the reply and the events before it. */
	readonly end: () => void;
};

/** The fields of a request type of an entry: its type, the schema of its lines, and whether a line is passive. */
const EntryRequestFields = {
	type: Type.String({ minLength: 1 }),
	schema: Type.Unsafe<TSchema>(Type.Object({})),
	/** Whether the line `request` does not count as activity for the idle exit. */
	passive: Type.Unsafe<(request: EntryLine) => boolean>(Type.Function([Type.Unknown()], Type.Unknown())),
};

/**
 * A request type of an entry, with exactly one of `handle`, which gives the reply, and `watch`, which gives the state
 * as the reply and then sends events.
 */
const EntryRequest = Type.Union([
	Type.Object({
		...EntryRequestFields,
		handle: Type.Unsafe<(request: EntryLine, options: { readonly signal: AbortSignal }) => Promise<JsonValue>>(
			Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()),
		),
		watch: Type.Optional(Type.Never()),
	}),
	Type.Object({
		...EntryRequestFields,
		watch: Type.Unsafe<(request: EntryLine, options: EntryWatchOptions) => Promise<JsonValue>>(
			Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()),
		),
		handle: Type.Optional(Type.Never()),
	}),
]);

export type EntryRequest = Static<typeof EntryRequest>;

/** The name and the version of the protocol of an entry, which the `hello` reply gives. */
const EntryProtocol = Type.Object({ name: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }) });

/**
 * What the default export of an entry returns: its extensions, the tasks that `start` runs, its catch-up hook, the
 * request types that it serves, the version of its protocol, and `close`.
 */
const EntryResult = Type.Object({
	extensions: Type.Unsafe<readonly Extension[]>(Type.Array(Type.Unknown())),
	tasks: Type.Optional(Type.Unsafe<readonly AnyTask[]>(Type.Array(Type.Unknown()))),
	catchUp: Type.Optional(CatchUpHook),
	requests: Type.Optional(Type.Array(EntryRequest)),
	protocol: Type.Optional(EntryProtocol),
	close: Type.Unsafe<() => Promise<void>>(Type.Function([], Type.Unknown())),
});

export type Entry = Static<typeof EntryResult>;

/**
 * The entries that the host loaded, as one: their extensions, tasks and catch-up hooks in load order, their request
 * types by type, the versions of their protocols by name, the event bus that they share, and `close`.
 */
export type LoadedEntries = {
	readonly extensions: readonly Extension[];
	readonly tasks: readonly AnyTask[];
	readonly catchUps: readonly CatchUpHook[];
	readonly requests: ReadonlyMap<string, EntryRequest>;
	readonly versions: Readonly<Record<string, number>>;
	readonly events: EventBus;
	close(): Promise<void>;
};

/** The classifier models of Pi's settings, and the questions to them, with the host's settings, models and states. */
export type EntryClassifier = {
	/** The model of the setting `key`, as the classifiers of the host find it. */
	model(key: ClassifierKey): Promise<ClassifierModel<ClassifierApi>>;
	/** The answers of `model` in `context`. */
	ask(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		signal: AbortSignal,
	): Promise<ClassifierResult["answers"]>;
};

/** The handles of the host that each entry gets, the same object for each. */
export type EntryHandles = {
	/** The state directory of the project. */
	readonly stateDir: string;
	/** The open asks of the store. It throws until the host is open, as `place.store` does. */
	readonly openAsks: () => Promise<AskList>;
	/** The degraded states of the host. */
	readonly degraded: Degraded;
	/** Writes a warning to the host's log. */
	readonly warn: (cause: unknown) => void;
	readonly classifier: EntryClassifier;
};

/** What the host gives the default export of an entry. */
type EntryOptions = EntryHandles & {
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
 * `entries.json` (see `readEntries`), with the children library `children` and the host's `handles`, in one shared
 * event bus, as one entry whose `close()` closes each of them and passes its errors to `handles.warn`. When an entry
 * fails to load, returns an invalid result, gives the kind of catch-up hook, a request type or the protocol name of an
 * earlier entry, or serves a request type of `coreTypes`, which the host owns, the entries loaded before it close.
 * Missing packages are skipped, not installed, and so is an entry module of `entries.json` that does not exist, such as
 * one of an uninstalled package, with a warning. A package or an entry that it skips is a degraded state in
 * `handles.degraded` for the life of the host.
 */
export async function loadEntries(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	place: Place,
	children: ChildrenLibrary,
	coreTypes: ReadonlySet<string>,
	handles: EntryHandles,
): Promise<LoadedEntries> {
	const { warn, degraded } = handles;
	const modules = new Set<string>();

	const roots = new DefaultPackageManager({ cwd, agentDir, settingsManager })
		.listConfiguredPackages()
		.flatMap((found) => found.installedPath ?? []);

	for (const root of new Set(roots)) {
		const path = join(root, "package.json");
		const manifest: unknown = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));

		if (!Value.Check(PackageJson, manifest)) {
			degraded.warn("package-skipped", path, `${path} is not a valid package.json`);
			continue;
		}

		if (!Value.Check(Manifest, manifest)) {
			degraded.warn("package-skipped", path, `${path} has an invalid piDurable field`);
			continue;
		}

		for (const path of manifest.piDurable?.extensions ?? []) modules.add(resolvePath(root, path));
	}

	for (const [name, module] of Object.entries(readEntries())) {
		if (existsSync(module)) {
			modules.add(module);
			continue;
		}

		degraded.warn("entry-skipped", name, `The entry ${name} has no module at ${module}; the host skips it`);
	}

	const events = createEventBus();
	const entries: Entry[] = [];
	/** The module of each catch-up hook kind, request type and protocol name. */
	const owners = new Map<string, string>();
	const requests = new Map<string, EntryRequest>();
	const versions: Record<string, number> = {};

	const close = async () => {
		for (const result of await Promise.allSettled(entries.map((entry) => entry.close()))) {
			if (result.status === "rejected") warn(result.reason);
		}
	};

	try {
		for (const module of modules) {
			const entry = await importEntry(module);
			const result: unknown = await entry.default({ ...handles, durable, ai, events, children, place });

			if (!Value.Check(EntryResult, result)) {
				throw new Error(
					`The entry ${module} returned an invalid result: ${invalidReason(Value.Errors(EntryResult, result))}`,
				);
			}

			entries.push(result);
			const kind = result.catchUp?.kind;

			if (kind !== undefined) claim(owners, module, "give the catch-up hook", kind);

			for (const request of result.requests ?? []) {
				if (coreTypes.has(request.type)) {
					throw new Error(`The entry ${module} serves the request type ${request.type}, which the host owns`);
				}

				claim(owners, module, "serve the request type", request.type);
				requests.set(request.type, request);
			}

			if (result.protocol !== undefined) {
				claim(owners, module, "give the protocol", result.protocol.name);
				versions[result.protocol.name] = result.protocol.version;
			}
		}
	} catch (error) {
		await close();
		throw error;
	}

	return {
		extensions: entries.flatMap((entry) => entry.extensions),
		tasks: entries.flatMap((entry) => entry.tasks ?? []),
		catchUps: entries.flatMap((entry) => (entry.catchUp === undefined ? [] : [checkedHook(entry.catchUp)])),
		requests,
		versions,
		events,
		close,
	};
}

/**
 * Records `module` as the owner of `what key`, such as `serve the request type T`, in `owners`. Throws
 * `The entries <a> and <b> both <what> <key>` when another module owns it.
 */
function claim(owners: Map<string, string>, module: string, what: string, key: string): void {
	const owner = `${what} ${key}`;
	const other = owners.get(owner);

	if (other !== undefined) throw new Error(`The entries ${other} and ${module} both ${owner}`);

	owners.set(owner, module);
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
