import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { addAsks } from "../src/host/asks.ts";
import { ChildRecords } from "../src/host/records.ts";
import type { Host } from "../src/host/run.ts";
import { runHost } from "../src/host/run.ts";
import { AskList } from "../src/protocol/asks.ts";
import { entriesPath, readEntries, setEntry } from "../src/protocol/entries.ts";
import { onLines } from "../src/protocol/lines.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { PROTOCOL_VERSION } from "../src/protocol/requests.ts";
import {
	answerOf,
	createProject,
	models,
	openDurableHost,
	requests,
	root,
	send,
	setUp,
	spawnAs,
	startHost,
	startHostProcess,
	tearDown,
	until,
} from "./helpers.ts";

const PROJECT = "entries";
const TYPEBOX = import.meta.resolve("typebox");

/** The module of the entry that relays a request through the `send` of the scope. */
const SCOPE_RELAY_MODULE = fileURLToPath(new URL("fixtures/scope-relay.ts", import.meta.url));

let host: Host | undefined;

/** An entry with two extensions, each with one tool, and the second one uninherited. */
const UNINHERITED_ENTRY = `import { Type } from ${JSON.stringify(TYPEBOX)};
export default function uninheritedEntry({ durable }) {
	const tool = (name) => durable.defineTool({
		name,
		description: name,
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => ({ output: [{ type: "text", text: name }] }),
	});
	return {
		extensions: [
			durable.defineExtension({ name: "fixture-kept", tools: [tool("fixture_kept")] }),
			durable.defineExtension({ name: "fixture-own", tools: [tool("fixture_own")] }),
		],
		uninherited: ["fixture-own"],
		close: async () => {},
	};
}
`;

/** The entry of the tests, with requests of each kind and the protocol `fixture` at version 3. */
const FIXTURE_ENTRY = `import { Type } from ${JSON.stringify(TYPEBOX)};
export default function fixtureEntry(handles) {
	const classifier = async () => {
		try {
			await handles.classifier.model("todoClassifier");
			return "found";
		} catch (error) {
			return error.message;
		}
	};
	return {
		extensions: [],
		protocol: { name: "fixture", version: 3 },
		requests: [
			{
				type: "fixture.echo",
				schema: Type.Object({ text: Type.String({ minLength: 1 }) }),
				passive: (request) => request.text === "poll",
				handle: async (request) => ({ echo: request.text }),
			},
			{
				type: "fixture.handles",
				schema: Type.Object({}),
				passive: () => true,
				handle: async () => ({
					stateDir: handles.stateDir,
					classifier: await classifier(),
					degraded: handles.degraded.list().map((state) => state.kind),
				}),
			},
			{
				type: "fixture.watch",
				schema: Type.Object({ count: Type.Integer() }),
				passive: () => true,
				watch: async (request, { emit, end }) => {
					emit({ n: 0 });
					setTimeout(() => {
						for (let n = 1; n <= request.count; n++) emit({ n });
						end();
					}, 20);
					return { count: request.count };
				},
			},
		],
		close: async () => {},
	};
}
`;

/** What the entry of the open and busy calls shares with the tests, through `globalThis`: it runs in this process. */
type Seams = {
	/** What each open call got: the root conversation, whether its harness is the host's store, and the live workers. */
	opened: { root: string; store: boolean; workers: number }[];
	/** What the busy call gives. */
	busy: boolean;
};

const seams: Seams = { opened: [], busy: false };

Object.assign(globalThis, { harnessSeams: seams });

/** The entry of the open and busy calls, which records each open and is busy while `seams.busy` is true. */
const SEAMS_ENTRY = `export default function seamsEntry(handles) {
	const seams = globalThis.harnessSeams;
	return {
		extensions: [],
		open: async ({ harness, root }) => {
			const workers = await handles.liveWorkers();
			seams.opened.push({ root: String(root.id), store: harness === handles.place.store, workers: workers.size });
		},
		busy: () => seams.busy,
		close: async () => {},
	};
}
`;

/** Each line that the socket of `project` sends for `lines`, until it ends, or until `count` lines came. */
function exchange(project: string, lines: readonly unknown[], count?: number): Promise<unknown[]> {
	const socket = createConnection(statePaths(project).socket);
	const received: unknown[] = [];

	return new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.once("end", () => resolve(received));
		onLines(socket, (line) => {
			received.push(JSON.parse(line));

			if (received.length === count) {
				socket.destroy();
				resolve(received);
			}
		});
		socket.write(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	});
}

/** Writes the entry module `name`.mjs with `source`, and gives its path. */
async function entryModule(name: string, source: string): Promise<string> {
	const module = join(root, `${name}.mjs`);
	await writeFile(module, source);

	return module;
}

/** A module whose entry serves `types`, gives the protocol `protocol`, and writes `<module>.closed` when it closes. */
async function servingEntry(name: string, types: readonly string[], protocol?: string): Promise<string> {
	const module = join(root, `${name}.mjs`);

	const requests = types.map(
		(type) => `{ type: ${JSON.stringify(type)}, schema: {}, passive: () => true, handle: async () => null }`,
	);

	const protocolField = protocol === undefined ? "" : `protocol: { name: ${JSON.stringify(protocol)}, version: 1 },`;

	await writeFile(
		module,
		`import { writeFile } from "node:fs/promises";
export default () => ({
	extensions: [],
	requests: [${requests.join(", ")}],
	${protocolField}
	close: () => writeFile(${JSON.stringify(`${module}.closed`)}, ""),
});
`,
	);

	return module;
}

/** The `subagent.children` document of version 6, whose records serve a spawner, a parley, a contract or an item. */
const ChildrenV6 = durable.defineDoc<durable.JsonObject>({
	kind: "subagent.children",
	version: 6,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ children: {}, requests: {} }),
});

/**
 * Starts a host of a new project with only the entries `entries`, by name, and gives it. `entries.json` then has its
 * entries from before again.
 */
async function startWith(project: string, entries: Record<string, string>): Promise<Host> {
	await createProject(project);

	return restartWith(project, entries);
}

/**
 * Starts a host of the project `project` with only the entries `entries`, by name, and gives it. `entries.json` then
 * has its entries from before again.
 */
async function restartWith(project: string, entries: Record<string, string>): Promise<Host> {
	const before = readEntries();
	await writeFile(entriesPath(), JSON.stringify(entries));

	try {
		return await startHost(project);
	} finally {
		await writeFile(entriesPath(), JSON.stringify(before));
	}
}

/** Starts a host of a new project with only the entries `entries`, by name, and gives the error of its start. */
async function startError(project: string, entries: Record<string, string>): Promise<string> {
	try {
		const started = await startWith(project, entries);
		await started.close();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	throw new Error(`The host of ${project} started`);
}

beforeAll(async () => {
	await setUp();
	setEntry("fixture", await entryModule("fixture-entry", FIXTURE_ENTRY));
	await createProject(PROJECT);
	host = await startHost(PROJECT);
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("entry requests", () => {
	it("gives the protocol versions of the entries in the hello reply", async () => {
		expect(await exchange(PROJECT, [{ type: "hello", version: PROTOCOL_VERSION }], 1)).toEqual([
			{ ok: true, value: { version: PROTOCOL_VERSION, pid: process.pid, entries: { fixture: 3 } } },
		]);
	});

	it("routes a line of an entry type to its handler, and checks it against the schema of the entry", async () => {
		const replies = await exchange(
			PROJECT,
			[
				{ type: "fixture.echo", text: "hi" },
				{ type: "fixture.echo" },
				{ type: "fixture.echo", text: "" },
				{ type: "fixture.none" },
				{ type: "list", caller: "cli" },
			],
			5,
		);

		expect(replies).toEqual([
			{ ok: true, value: { echo: "hi" } },
			{ ok: false, error: "Invalid fixture.echo request: text: required" },
			{ ok: false, error: "Invalid fixture.echo request: text: must not have fewer than 1 characters" },
			{ ok: false, error: 'no loaded entry serves request type "fixture.none"' },
			{ ok: true, value: [] },
		]);
	});

	it("gives the entries the state directory and the classifier", async () => {
		expect(await exchange(PROJECT, [{ type: "fixture.handles" }], 1)).toEqual([
			{
				ok: true,
				value: {
					stateDir: statePaths(PROJECT).dir,
					classifier: "No classifier: log in to typesafe or set todoClassifier",
					degraded: ["no-classifier"],
				},
			},
		]);
	});

	it("sends the events of an entry watch after its reply, in order, and ends the connection at its end", async () => {
		expect(await exchange(PROJECT, [{ type: "fixture.watch", count: 2 }])).toEqual([
			{ ok: true, value: { count: 2 } },
			{ event: { n: 0 } },
			{ event: { n: 1 } },
			{ event: { n: 2 } },
		]);
	});

	it("counts an entry line as activity for the idle exit only when its passive rule says so", async () => {
		const project = "entries-idle";
		const dir = await createProject(project);
		// The host exits once it had no connection and no activity for 300 ms.
		const idle = await runHost({ project, cwd: dir, models, idleExitMs: 300 });

		if (idle === undefined) throw new Error("no host");
		let closed = false;
		void idle.closed.then(() => (closed = true));

		try {
			for (const end = Date.now() + 1000; Date.now() < end;) {
				await exchange(project, [{ type: "fixture.echo", text: "work" }], 1);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			expect(closed).toBe(false);

			const polling = (async () => {
				while (!closed) {
					await exchange(project, [{ type: "fixture.echo", text: "poll" }], 1).catch(() => undefined);
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			})();

			await until(() => closed);
			await polling;
		} finally {
			await idle.close();
		}
	});
});

describe("entry load errors", () => {
	it("refuses two entries that serve the same request type, and closes the entry loaded before", async () => {
		const first = await servingEntry("first-type", ["shared.type"]);
		const second = await servingEntry("second-type", ["shared.type"]);

		expect(await startError("dup-type", { first, second })).toBe(
			`The entries ${first} and ${second} both serve the request type shared.type`,
		);
		expect(existsSync(`${first}.closed`)).toBe(true);
	});

	it("refuses an entry that serves a request type of the host", async () => {
		const first = await servingEntry("first-core", []);
		const core = await servingEntry("core-type", ["todo"]);

		expect(await startError("core-type", { first, core })).toBe(
			`The entry ${core} serves the request type todo, which the host owns`,
		);
		expect(existsSync(`${first}.closed`)).toBe(true);
	});

	it("refuses two entries that give the same protocol name", async () => {
		const first = await servingEntry("first-protocol", [], "same");
		const second = await servingEntry("second-protocol", [], "same");

		expect(await startError("dup-protocol", { first, second })).toBe(
			`The entries ${first} and ${second} both give the protocol same`,
		);
		expect(existsSync(`${first}.closed`)).toBe(true);
	});

	it("refuses two entries that give a handler of the ask requests", async () => {
		const source = `export default () => ({ extensions: [], ask: async () => ({ asks: [] }), close: async () => {} });\n`;
		const first = await entryModule("first-asks", source);
		const second = await entryModule("second-asks", source);

		expect(await startError("dup-asks", { first, second })).toBe(
			`The entries ${first} and ${second} both give the handler of the ask requests`,
		);
	});

	it("refuses two entries that check the same label kind", async () => {
		const labels = `export default () => ({ extensions: [], labels: [{ kind: "fix", check: async () => {} }], close: async () => {} });\n`;
		const first = await entryModule("first-label", labels);
		const second = await entryModule("second-label", labels);

		expect(await startError("dup-label", { first, second })).toBe(
			`The entries ${first} and ${second} both check the label kind fix`,
		);
	});

	it("refuses a request type with both a handler and a watch", async () => {
		const both = await entryModule(
			"both-entry",
			`export default () => ({
	extensions: [],
	requests: [{ type: "both", schema: {}, passive: () => true, handle: async () => null, watch: async () => null }],
	close: async () => {},
});
`,
		);

		expect(await startError("both", { both })).toMatch(
			new RegExp(`^The entry ${both.replaceAll(".", "\\.")} returned an invalid result: /requests/0`),
		);
	});
});

describe("the harness host process", { timeout: 30_000 }, () => {
	it("writes no projects entry in entries.json", async () => {
		const project = "host-process";
		await createProject(project);
		const client = await startHostProcess(project);
		client.close();

		try {
			expect(client.pid).not.toBe(process.pid);
			expect(readEntries()).not.toHaveProperty("projects");
		} finally {
			process.kill(client.pid, "SIGTERM");
			await until(() => !existsSync(statePaths(project).socket));
		}
	});
});

describe("the scope of the entries", () => {
	it("serves a request of an entry type in the process with send, checks it against the schema of the entry, and refuses a type that no entry serves", async () => {
		const project = "scope-relay";
		const relaying = await startWith(project, { relay: SCOPE_RELAY_MODULE });

		try {
			const relays = [
				{ type: "fixture.relay", to: "fixture.shout", text: "hi" },
				{ type: "fixture.relay", to: "fixture.shout", text: "" },
				{ type: "fixture.relay", to: "item", text: "hi" },
			];

			expect(await exchange(project, relays, 3)).toEqual([
				{ ok: true, value: { shout: "HI" } },
				{
					ok: true,
					value: { error: "Invalid fixture.shout request: text: must not have fewer than 1 characters" },
				},
				{ ok: true, value: { error: 'no loaded entry serves request type "item"' } },
			]);
		} finally {
			await relaying.close();
		}
	});
});

describe("the uninherited extensions of an entry", () => {
	it("gives a child the other extensions of the entry, and not the uninherited ones", async () => {
		const project = "uninherited";
		const opened = await startWith(project, { own: await entryModule("uninherited-entry", UNINHERITED_ENTRY) });

		try {
			const child = await spawnAs("uninherited", "Uninherited child", { notify: false, project });
			await answerOf(child.handle, project);
			const tools = requests.get("Uninherited child")?.tools.filter((name) => name.startsWith("fixture_"));
			expect(tools).toEqual(["fixture_kept"]);
		} finally {
			await opened.close();
		}
	});
});

describe("the open and busy calls of an entry", () => {
	it("opens the entry once with the root conversation and the store of the host", async () => {
		const project = "seams-open";
		const opened = await startWith(project, { seams: await entryModule("seams-entry", SEAMS_ENTRY) });

		try {
			expect(seams.opened).toEqual([{ root: expect.any(String), store: true, workers: 0 }]);
			const caller = seams.opened[0]?.root ?? "";
			expect(await send({ type: "whoami", caller }, project)).toEqual({ handle: "agent" });
		} finally {
			await opened.close();
			seams.opened.length = 0;
		}
	});

	it("keeps the host from its idle exit while the entry is busy", async () => {
		const project = "seams-busy";
		const dir = await createProject(project);
		const before = readEntries();
		await writeFile(entriesPath(), JSON.stringify({ seams: await entryModule("seams-entry", SEAMS_ENTRY) }));
		seams.busy = true;

		// The host exits once it had no connection and no activity for 300 ms, and the entry is not busy.
		const idle = await runHost({ project, cwd: dir, models, idleExitMs: 300 }).finally(() =>
			writeFile(entriesPath(), JSON.stringify(before)),
		);

		if (idle === undefined) throw new Error("no host");
		let closed = false;
		void idle.closed.then(() => (closed = true));

		try {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(closed).toBe(false);
			seams.busy = false;
			await until(() => closed);
		} finally {
			seams.busy = false;
			seams.opened.length = 0;
			await idle.close();
		}
	});
});

describe("a host without the projects entry", () => {
	let bare: Host | undefined;
	const project = "no-projects";

	beforeAll(async () => {
		bare = await startWith(project, {});
	});

	afterAll(async () => {
		await bare?.close();
	});

	it("serves a spawn and its wait, and refuses a request of the projects with the error that names its type", async () => {
		expect(await exchange(project, [{ type: "hello", version: PROTOCOL_VERSION }], 1)).toEqual([
			{ ok: true, value: { version: PROTOCOL_VERSION, pid: process.pid, entries: {} } },
		]);
		const child = await spawnAs("bare-spawn", "Bare child", { notify: false, project });
		expect(await answerOf(child.handle, project)).toBe("Answer to Bare child");
		expect(await exchange(project, [{ type: "item", action: "list" }], 1)).toEqual([
			{ ok: false, error: 'no loaded entry serves request type "item"' },
		]);
	});

	it("serves a plain round of asks and their list, and refuses a round of a parley", async () => {
		const round = { type: "ask", action: "round", caller: "cli", asks: [{ title: "Ship it?" }] };
		const parley = { ...round, parley: { slug: "ship", title: "Ship", goal: "Ship the change." } };
		const [written, listed, refused] = await exchange(project, [round, { type: "ask", action: "list" }, parley], 3);

		const ask = { id: 1, title: "Ship it?", state: "open", asker: "cli", at: expect.any(Number), by: "cli" };
		expect(written).toEqual({ ok: true, value: { parleys: [], asks: [ask] } });
		expect(listed).toEqual({ ok: true, value: { asks: [ask] } });
		expect(refused).toEqual({ ok: false, error: "no loaded entry serves parley asks" });
	});

	it("answers and drops an ask that serves a parley as a plain ask, and keeps its parley as data", async () => {
		await offline(async (store) => {
			await store.commit(async (tx) => {
				const parley = { id: 1, n: 1 };

				const asks = [
					{ input: { title: "Kept?" }, parley },
					{ input: { title: "Dropped?" }, parley },
				];

				await addAsks(tx, asks, "cli", 1);
			}, BACKGROUND_CONTEXT);
		});

		const { asks } = Value.Parse(AskList, await send({ type: "ask", action: "list" }, project));
		const [kept, dropped] = asks.filter((ask) => ask.parley !== undefined).map((ask) => ask.id);

		const answer = {
			type: "ask",
			action: "answer",
			caller: "cli",
			answers: [{ id: kept, answer: "own", label: "Yes", words: ["yes"] }],
		};

		const drop = { type: "ask", action: "drop", caller: "cli", id: dropped };
		const [answered, gone] = await exchange(project, [answer, drop], 2);

		expect(answered).toMatchObject({
			ok: true,
			value: { asks: [{ id: kept, state: "answered", parley: { id: 1, n: 1 } }] },
		});
		expect(gone).toMatchObject({
			ok: true,
			value: { asks: [{ id: dropped, state: "dropped", parley: { id: 1, n: 1 } }] },
		});
	});

	it("reads the children of a store of version 6 with the labels that the host names from their records", async () => {
		const handles: string[] = [];

		for (const prompt of ["parley", "contract", "item", "spawner"]) {
			handles.push((await spawnAs("bare-session", `Task:\nServe ${prompt}`, { notify: false, project })).handle);
		}

		const [byParley = "", byContract = "", byItem = "", bySpawner = ""] = handles;

		const served = {
			[byParley]: { serves: { kind: "parley", slug: "old-open" } },
			[byContract]: { serves: { kind: "contract", slug: "old-contract" } },
			[byItem]: { serves: { kind: "item" } },
			[bySpawner]: { serves: { kind: "spawner" }, servedEnd: "due" },
		} satisfies Record<string, durable.JsonObject>;

		await offline(async (store) => {
			const state = await store.snapshot(ChildRecords, BACKGROUND_CONTEXT);

			if (state === undefined) throw new Error("no records");

			const children = Object.fromEntries(
				Object.entries(Value.Clone(state).children).map(([handle, { labels: _labels, ...record }]) => [
					handle,
					// A child of an earlier test serves its spawner.
					{ ...record, ...(served[handle] ?? { serves: { kind: "spawner" } }) },
				]),
			);

			await store.commit((tx) => tx.retireDoc(ChildRecords), BACKGROUND_CONTEXT);

			await store.commit(async (tx) => {
				Object.assign(await tx.doc(ChildrenV6), { children, requests: state.requests });
			}, BACKGROUND_CONTEXT);
		});

		const status = (handle: string) => send({ type: "status", handle }, project);
		expect(await status(byParley)).toMatchObject({ handle: byParley, labels: ["parley:old-open"] });
		expect(await status(byContract)).toMatchObject({ handle: byContract, labels: ["parley:old-contract"] });

		for (const handle of [byItem, bySpawner]) {
			const child = await status(handle);
			expect(child).toMatchObject({ handle });
			expect(child).not.toHaveProperty("labels");
		}
	});

	it("refuses a record of version 6 with no serves with the path of the field", () => {
		const record = { caller: "cli", createdAt: "2025-01-01", conversationId: 7, requests: [], read: 0 };
		const { definition } = ChildRecords;

		const migrate = (value: durable.JsonObject) => {
			if (definition.migrate === undefined) throw new Error("no migration");

			return definition.migrate(value, 6);
		};

		expect(() => migrate({ children: { a1: record }, requests: {} })).toThrow(
			"subagent.children of version 6 is invalid: /children/a1 must have required properties serves",
		);
		expect(migrate({ children: { a1: { ...record, serves: { kind: "parley", slug: "old" } } }, requests: {} })).toEqual(
			{ children: { a1: { ...record, labels: ["parley:old"] } }, requests: {} },
		);
	});

	/** Runs `write` on the store of the host without the projects entry while it is closed, and starts it again. */
	async function offline(write: (store: durable.Harness) => Promise<void>): Promise<void> {
		await bare?.close();
		bare = undefined;
		const store = await openDurableHost(join(statePaths(project).dir, "durable.sqlite"), []);

		try {
			await write(store);
		} finally {
			await store.close(BACKGROUND_CONTEXT);
		}

		bare = await restartWith(project, {});
	}
});
