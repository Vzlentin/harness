import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ChildRecords, type ChildrenState } from "../src/host/records.ts";
import type { Host } from "../src/host/run.ts";
import { ConversationTodos } from "../src/host/todo-lists.ts";
import { ItemCounterDoc, Items } from "../src/projects/item-docs.ts";
import { ItemList, StagedItem } from "../src/protocol/item.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { AskWrite } from "../src/protocol/project.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { Todo } from "../src/protocol/todo.ts";
import { TreeReply } from "../src/protocol/tree.ts";
import {
	createProject,
	openDurableHost,
	OPTIONS,
	readStoreFile,
	send,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	until,
	untilContract,
} from "./helpers.ts";

const PROJECT = "migration";
const LABELS_PROJECT = "labels-migration";

/** The `subagent.children` document as version 5 kept it, whose records can serve a todo of the project. */
const ChildrenV5 = durable.defineDoc<durable.JsonObject>({
	kind: "subagent.children",
	version: 5,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ children: {}, requests: {} }),
});

/** The `subagent.children` document as version 6 kept it, whose records serve a spawner, a parley, a contract or an item. */
const ChildrenV6 = durable.defineDoc<durable.JsonObject>({
	kind: "subagent.children",
	version: 6,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ children: {}, requests: {} }),
});

beforeAll(async () => {
	await setUp();
});

afterAll(async () => {
	await tearDown();
});

/** Spawns an idle child of the project with the first message `prompt`, and gives its handle. */
async function spawnIdle(prompt: string): Promise<string> {
	const { handle } = await spawnAs("migration-session", prompt, { notify: false, project: PROJECT });
	await vi.waitFor(async () => expect(await stateOf(handle)).toBe("idle"), { timeout: 10_000 });

	return handle;
}

async function stateOf(handle: string): Promise<string> {
	return (await send({ type: "status", handle }, PROJECT)).state;
}

async function addTodo(handle: string, text: string): Promise<number> {
	return Value.Parse(Todo, await send({ type: "todo", caller: "cli", action: "add", handle, text }, PROJECT)).id;
}

async function setTodo(handle: string, id: number, state: "doing" | "done" | "dropped"): Promise<void> {
	await send({ type: "todo", caller: "cli", action: "set", handle, id, state }, PROJECT);
}

async function items(): Promise<ItemList["items"]> {
	return Value.Parse(ItemList, await send({ type: "item", action: "list" }, PROJECT)).items;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Makes the store of the project a store of the host before the work items: it retires the counter of the IDs of items,
 * and writes the records of the children at version 5, where the child of each handle of `todos` serves that todo. Each
 * todo of the root list whose ID is a key of `asks` gets that ask, as an ask with a todo had one before the items.
 */
async function storeBeforeItems(
	todos: Readonly<Record<string, number>>,
	asks: Readonly<Record<number, number>>,
): Promise<void> {
	const store = await openDurableHost(join(statePaths(PROJECT).dir, "durable.sqlite"), []);

	try {
		const state = await store.snapshot(ChildRecords, BACKGROUND_CONTEXT);

		if (state === undefined) throw new Error("no records");
		const old: ChildrenState = Value.Clone(state);

		const children = Object.fromEntries(
			Object.entries(old.children).map(([handle, { labels: _labels, ...record }]) => {
				const id = todos[handle];

				return [handle, { ...record, serves: id === undefined ? { kind: "spawner" } : { kind: "todo", id } }];
			}),
		);

		const root = await store.root(BACKGROUND_CONTEXT);

		await store.commit(async (tx) => {
			for (const todo of (await tx.doc(ConversationTodos, root.id)).todos) {
				const ask = asks[todo.id];

				if (ask !== undefined) todo.ask = ask;
			}

			await tx.retireDoc(ChildRecords);
			await tx.retireDoc(ItemCounterDoc);
		}, BACKGROUND_CONTEXT);

		await store.commit(async (tx) => {
			Object.assign(await tx.doc(ChildrenV5), { children, requests: old.requests });
		}, BACKGROUND_CONTEXT);
	} finally {
		await store.close(BACKGROUND_CONTEXT);
	}
}

describe("the move of the todos of the project to items", { timeout: 60_000 }, () => {
	it("moves the open todos once, labels the children that served a moved todo, and skips the IDs of old todos", async () => {
		await createProject(PROJECT);
		let host: Host | undefined = await startHost(PROJECT);
		let moved: string;
		let finished: string;
		let busy: string;
		let asked: string;
		let own: number;
		let ask: number;

		try {
			moved = await spawnIdle("Task:\nServe the open todo");
			finished = await spawnIdle("Task:\nServe the done todo");
			busy = await spawnIdle("Task:\nServe the done todo with work");
			asked = await spawnIdle("Task:\nServe the asked todo");
			expect(await addTodo(AGENT_HANDLE, "Open work")).toBe(1);
			expect(await addTodo(AGENT_HANDLE, "Done work")).toBe(2);
			expect(await addTodo(AGENT_HANDLE, "Dropped work")).toBe(3);
			await setTodo(AGENT_HANDLE, 2, "done");
			await setTodo(AGENT_HANDLE, 3, "dropped");
			expect(await addTodo(AGENT_HANDLE, "Doing work")).toBe(4);
			await setTodo(AGENT_HANDLE, 4, "doing");
			expect(await addTodo(AGENT_HANDLE, "Asked work")).toBe(5);

			const round = Value.Parse(
				AskWrite,
				await send({ type: "ask", action: "round", caller: "agent", asks: [{ title: "Which work" }] }, PROJECT),
			);

			ask = round.asks[0]?.id ?? 0;
			own = await addTodo(busy, "Own work");
		} finally {
			await host.close();
		}

		await storeBeforeItems({ [moved]: 1, [finished]: 2, [busy]: 3, [asked]: 5 }, { 5: ask });
		host = await startHost(PROJECT);

		try {
			expect(await items()).toEqual([
				{
					id: 1,
					title: "Open work",
					state: "open",
					edges: [],
					at: expect.any(Number),
					by: "migration",
					stage: "building",
					needsYou: false,
				},
				{
					id: 4,
					title: "Doing work",
					state: "open",
					edges: [],
					at: expect.any(Number),
					by: "migration",
					stage: "inbox",
					needsYou: false,
				},
			]);

			expect(await send({ type: "todo", caller: "cli", action: "list", handle: AGENT_HANDLE }, PROJECT)).toEqual({
				todos: [
					{ id: 1, text: "moved to item 1: Open work", state: "dropped" },
					{ id: 2, text: "Done work", state: "done" },
					{ id: 3, text: "Dropped work", state: "dropped" },
					{ id: 4, text: "moved to item 4: Doing work", state: "dropped" },
					{ id: 5, text: "Asked work", state: "open", ask },
				],
			});

			expect(await send({ type: "status", handle: moved }, PROJECT)).toMatchObject({
				state: "idle",
				labels: ["item:1"],
			});

			for (const handle of [finished, busy, asked]) {
				expect(await send({ type: "status", handle }, PROJECT)).not.toHaveProperty("labels");
			}

			const { nodes } = Value.Parse(TreeReply, await send({ type: "tree" }, PROJECT));
			expect(nodes.find((node) => node.id === moved)).toMatchObject({ labels: ["item:1"] });
			await expect(send({ type: "item", action: "read", id: 2 }, PROJECT)).rejects.toThrow("Unknown item: 2");
			await expect(send({ type: "item", action: "set", caller: "cli", id: 3, state: "done" }, PROJECT)).rejects.toThrow(
				"Unknown item: 3",
			);
			await until(() => readStoreFile(PROJECT)?.items.length === 2);
			expect(readStoreFile(PROJECT)).toMatchObject({ version: 2, lastItem: 5 });
			await sleep(300);

			for (const handle of [moved, finished, busy, asked]) expect(await stateOf(handle)).toBe("idle");
			expect(await addTodo(AGENT_HANDLE, "Later work")).toBe(6);
		} finally {
			await host.close();
		}

		host = await startHost(PROJECT);

		try {
			await sleep(300);
			expect(await stateOf(busy)).toBe("idle");
			expect(await stateOf(asked)).toBe("idle");
			expect((await items()).map((item) => item.id)).toEqual([1, 4]);
			expect(await send({ type: "todo", caller: "cli", action: "list", handle: AGENT_HANDLE }, PROJECT)).toMatchObject({
				todos: [
					{ id: 1 },
					{ id: 2 },
					{ id: 3 },
					{ id: 4 },
					{ id: 5, ask },
					{ id: 6, text: "Later work", state: "open" },
				],
			});

			const added = Value.Parse(
				StagedItem,
				await send({ type: "item", action: "add", caller: "cli", title: "New work" }, PROJECT),
			);

			expect(added.id).toBe(6);

			// A contract reads only the stored items, so the IDs of the old todos stay unknown.
			const written = Value.Parse(
				AskWrite,
				await send(
					{
						type: "ask",
						action: "round",
						caller: "pi-1",
						parley: { slug: "after-move", title: "After the move", goal: "Pick.", design_sense: "One." },
						asks: [
							{ title: "Where", kind: "your call", options: OPTIONS, plan: "a" },
							{ title: "These are the terms" },
						],
					},
					PROJECT,
				),
			);

			const answers = (written.parleys[0]?.asks ?? []).map((ask, index) => ({
				id: ask.id,
				answer: index === 0 ? "a" : "ok",
			}));

			await send({ type: "ask", action: "answer", caller: "user", user: true, answers }, PROJECT);
			await untilContract("after-move", PROJECT);
			expect((await items()).map((item) => [item.id, item.title])).toEqual([
				[1, "Open work"],
				[4, "Doing work"],
				[6, "New work"],
				[7, "After the move"],
			]);

			await setTodo(busy, own, "done");
			await sleep(300);
			expect(await stateOf(busy)).toBe("idle");
			expect(await stateOf(moved)).toBe("idle");
		} finally {
			await host.close();
			host = undefined;
		}
	});

	it("turns what each child of a store of version 6 served into its labels, and takes the serves edge of an agent", async () => {
		await createProject(LABELS_PROJECT);
		let host: Host | undefined = await startHost(LABELS_PROJECT);
		const handles: string[] = [];
		let item: number;

		try {
			for (const prompt of ["item", "parley", "contract", "spawner"]) {
				const { handle } = await spawnAs("labels-session", `Task:\nServe ${prompt}`, {
					notify: false,
					project: LABELS_PROJECT,
				});

				handles.push(handle);
			}

			const added = await send({ type: "item", action: "add", caller: "cli", title: "Served" }, LABELS_PROJECT);
			item = Value.Parse(StagedItem, added).id;
		} finally {
			await host.close();
		}

		const [byItem = "", byParley = "", byContract = "", bySpawner = ""] = handles;
		const store = await openDurableHost(join(statePaths(LABELS_PROJECT).dir, "durable.sqlite"), []);

		try {
			const state = await store.snapshot(ChildRecords, BACKGROUND_CONTEXT);

			if (state === undefined) throw new Error("no records");

			const served = {
				[byItem]: { serves: { kind: "item" } },
				[byParley]: { serves: { kind: "parley", slug: "old-open" } },
				[byContract]: { serves: { kind: "contract", slug: "old-contract" } },
				[bySpawner]: { serves: { kind: "spawner" }, servedEnd: "due" },
			} satisfies Record<string, durable.JsonObject>;

			const children = Object.fromEntries(
				Object.entries(Value.Clone(state).children).map(([handle, { labels: _labels, ...record }]) => [
					handle,
					{ ...record, ...served[handle] },
				]),
			);

			const agent = `agent:${state.children[byItem]?.conversationId}`;

			await store.commit(async (tx) => {
				await tx.retireDoc(ChildRecords);

				const stored = await tx.doc(Items, String(item), {
					id: item,
					title: "-",
					state: "open",
					edges: [],
					at: 0,
					by: "",
				});

				stored.edges.push({ from: agent, kind: "serves", to: `item:${item}`, at: 1, by: "old" });
			}, BACKGROUND_CONTEXT);

			await store.commit(async (tx) => {
				Object.assign(await tx.doc(ChildrenV6), { children, requests: state.requests });
			}, BACKGROUND_CONTEXT);
		} finally {
			await store.close(BACKGROUND_CONTEXT);
		}

		host = await startHost(LABELS_PROJECT);

		try {
			const labels = async (handle: string) => (await send({ type: "status", handle }, LABELS_PROJECT)).labels;
			expect(await labels(byItem)).toEqual([`item:${item}`]);
			expect(await labels(byParley)).toEqual(["parley:old-open"]);
			expect(await labels(byContract)).toEqual(["parley:old-contract"]);
			expect(await labels(bySpawner)).toBeUndefined();
			expect(
				Value.Parse(StagedItem, await send({ type: "item", action: "read", id: item }, LABELS_PROJECT)),
			).toMatchObject({ edges: [], stage: "building" });
		} finally {
			await host.close();
			host = undefined;
		}

		const after = await openDurableHost(join(statePaths(LABELS_PROJECT).dir, "durable.sqlite"), []);

		try {
			const records = Object.values((await after.snapshot(ChildRecords, BACKGROUND_CONTEXT))?.children ?? {});
			expect(records).toHaveLength(4);

			for (const record of records) {
				expect(record).not.toHaveProperty("serves");
				expect(record).not.toHaveProperty("servedEnd");
			}
		} finally {
			await after.close(BACKGROUND_CONTEXT);
		}
	});
});
