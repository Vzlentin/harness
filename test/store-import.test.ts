import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { sessionDoc } from "../src/projects/project-docs.ts";
import { GateReply } from "../src/protocol/gate.ts";
import { WorkItem } from "../src/protocol/item.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { Message, Person, Rule, Thread } from "../src/protocol/project.ts";
import type { StoreFile } from "../src/protocol/store-file.ts";
import {
	cli,
	createProject,
	OPTIONS,
	openDurableHost,
	readStores,
	root,
	send,
	setUp,
	startHost,
	tearDown,
} from "./helpers.ts";

/** The document of the persons, as an older version kept it in `durable.sqlite`. */
const OLD_PERSONS = sessionDoc<{ persons: Person[] }>("harness.persons", () => ({ persons: [] }));

/** `project.sqlite` of `project`. */
function projectStore(project: string): string {
	return join(statePaths(project).dir, "project.sqlite");
}

/** Removes `project.sqlite` of `project` with its WAL files, as a store of an older version has none. */
async function removeProjectStore(project: string): Promise<void> {
	for (const suffix of ["", "-wal", "-shm"]) await rm(`${projectStore(project)}${suffix}`, { force: true });
}

/** Starts a host of `project` and stops it. */
async function startAndStop(project: string): Promise<void> {
	const host = await startHost(project);
	await host.close();
}

/** Fills each list of the project store of `project`, whose host runs, and the asks of a parley round. */
async function fill(project: string): Promise<void> {
	const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

	const thread = Value.Parse(
		Thread,
		await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
	);

	const log = { type: "message", action: "log", caller: "cli", thread: thread.id } as const;

	const asked = Value.Parse(
		Message,
		await send({ ...log, from: "user", direction: "out", at: 1_000, text: "Which?" }, project),
	);

	await send({ ...log, from: sam.id, direction: "in", at: 2_000, text: "Retail." }, project);
	const set = { type: "rule", action: "set", caller: "cli", saidBy: sam.id, kind: "conduct", value: "First." } as const;
	const kept = Value.Parse(Rule, await send({ ...set, name: "ask", source: asked.id }, project));
	const gone = Value.Parse(Rule, await send({ ...set, name: "wait", source: asked.id }, project));
	await send({ type: "rule", action: "delete", caller: "cli", id: gone.id }, project);

	const gate = {
		type: "gate",
		requestId: "call-1",
		caller: "agent",
		tool: "bash",
		arguments: { command: `harness rule decide ${kept.id}` },
		messages: ["continue"],
	} as const;

	expect(Value.Parse(GateReply, await send(gate, project))).toMatchObject({ runs: false });

	await send(
		{
			type: "ask",
			action: "round",
			caller: "pi-1",
			parley: { slug: "where", title: "Where asks live", goal: "Pick the place." },
			asks: [{ title: "Where", kind: "your call", options: OPTIONS, plan: "a" }, { title: "These are the terms" }],
		},
		project,
	);

	for (const title of ["Scope", "Build", "Ship"])
		await send({ type: "item", action: "add", caller: "cli", title }, project);
	const link = { type: "item", action: "link", caller: "cli" } as const;
	await send({ ...link, kind: "needs", from: "item:2", to: "item:1" }, project);
	await send({ ...link, kind: "shapes", from: "parley:where", to: "item:3" }, project);
	await send({ type: "todo", action: "add", caller: "session-a", text: "Review" }, project);
}

/** Writes `file` as `store.json` of `project`, and gives its bytes. */
async function writeStoreJson(project: string, file: StoreFile): Promise<string> {
	const text = JSON.stringify(file);
	await writeFile(statePaths(project).store, text);

	return text;
}

beforeAll(async () => {
	await setUp();
});

afterAll(async () => {
	await tearDown();
});

describe("the import of store.json", { timeout: 60_000 }, () => {
	it("imports store.json into project.sqlite at the first start with the IDs of the file, and never writes it", async () => {
		const project = "import";
		await createProject(project);
		const host = await startHost(project);

		try {
			await fill(project);
		} finally {
			await host.close();
		}

		// A host never writes store.json.
		expect(existsSync(statePaths(project).store)).toBe(false);
		const file = await readStores(project);
		expect(file).toMatchObject({ lastRule: 2, lastItem: 3 });
		expect(file.items.flatMap((item) => item.edges).map(({ from, kind, to }) => `${from} ${kind} ${to}`)).toEqual([
			"item:2 needs item:1",
			"parley:where shapes item:3",
		]);
		expect(
			[file.persons, file.threads, file.rules, file.held, file.parleys, file.asks].map((list) => list.length),
		).toEqual([1, 1, 1, 1, 1, 2]);
		const text = await writeStoreJson(project, file);
		await removeProjectStore(project);

		const imported = await startHost(project);

		try {
			expect(existsSync(projectStore(project))).toBe(true);

			// The counters of the file give the next IDs.
			const next = Value.Parse(
				WorkItem,
				await send({ type: "item", action: "add", caller: "cli", title: "Next" }, project),
			);

			expect(next.id).toBe(4);
			expect(readFileSync(statePaths(project).store, "utf8")).toBe(text);
			await send({ type: "item", action: "set", caller: "cli", id: next.id, state: "dropped" }, project);
		} finally {
			await imported.close();
		}

		const { items, lastItem, ...lists } = await readStores(project);
		const { items: fileItems, lastItem: _lastItem, ...fileLists } = file;
		expect(lists).toEqual(fileLists);
		expect(items.slice(0, 3)).toEqual(fileItems);
		expect(lastItem).toBe(4);
		expect(readFileSync(statePaths(project).store, "utf8")).toBe(text);
	});

	it("refuses a file whose parley has an ask that durable.sqlite does not have, and leaves no project.sqlite", async () => {
		const project = "import-missing";
		await createProject(project);
		await startAndStop(project);
		const parley = 1;

		const file: StoreFile = {
			...(await readStores(project)),
			parleys: [{ id: parley, slug: "where", title: "Where", goal: "Pick.", status: "open", at: 1, by: "pi-1" }],
			asks: [{ id: 7, title: "Where", parley: { id: parley, n: 1 }, state: "open", asker: "pi-1", at: 1, by: "pi-1" }],
		};

		await writeStoreJson(project, file);
		await removeProjectStore(project);

		await expect(startHost(project)).rejects.toThrow("The ask 7 of the parley where is not in durable.sqlite");
		expect(existsSync(projectStore(project))).toBe(false);
	});

	it("refuses an old durable.sqlite with the lists of the project and no store.json, and leaves no project.sqlite", async () => {
		const project = "import-old";
		await createProject(project);
		await startAndStop(project);
		await removeProjectStore(project);
		const { dir } = statePaths(project);
		const older = await openDurableHost(join(dir, "durable.sqlite"), []);

		await older.commit(async (tx) => {
			(await tx.doc(OLD_PERSONS)).persons.push({ id: 1, name: "Sam" });
		}, BACKGROUND_CONTEXT);
		await older.close(BACKGROUND_CONTEXT);

		const refused = startHost(project);
		await expect(refused).rejects.toThrow(dir);
		await expect(refused).rejects.toThrow("harness store load");
		expect(existsSync(projectStore(project))).toBe(false);
	});

	it("leaves no project.sqlite when the import of a host or of store load fails", async () => {
		const project = "import-twice";
		await createProject(project);
		await startAndStop(project);
		const parley = { id: 1, slug: "where", title: "Where", goal: "Pick.", status: "open", at: 1, by: "pi-1" } as const;
		// The parse takes the file, and the UNIQUE slug of project.sqlite refuses it.
		const file: StoreFile = { ...(await readStores(project)), parleys: [parley, { ...parley, id: 2 }] };
		await writeStoreJson(project, file);
		await removeProjectStore(project);

		await expect(startHost(project)).rejects.toThrow("UNIQUE");
		expect(existsSync(projectStore(project))).toBe(false);

		const path = join(root, "import-twice.json");
		await writeFile(path, JSON.stringify(file));
		const loaded = await cli(["--project", project, "store", "load", path]);
		expect(loaded).toMatchObject({ code: 1, stdout: "" });
		expect(loaded.stderr).toContain("UNIQUE");
		expect(existsSync(projectStore(project))).toBe(false);
	});

	it("opens an existing project.sqlite and does not read store.json", async () => {
		const project = "import-kept";
		await createProject(project);
		await startAndStop(project);
		await writeFile(statePaths(project).store, "{");

		await startAndStop(project);
		expect(existsSync(projectStore(project))).toBe(true);
	});
});
