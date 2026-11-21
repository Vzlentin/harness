import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { StagedItem } from "../src/protocol/item.ts";
import { Todo } from "../src/protocol/todo.ts";
import type { SpawnServes, Worker } from "../src/protocol/worker-labels.ts";
import {
	aborted,
	answer,
	answerOf,
	called,
	cli,
	contractItem,
	framed,
	gates,
	handleOf,
	openWatch,
	root,
	send,
	setUp,
	spawnAs,
	spawnWithId,
	startHost,
	stateOf,
	tearDown,
	until,
	untilContract,
	untilState,
} from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

/** What the entry of the tests shares with them, through `globalThis`, since it runs in this process. */
type Shared = {
	handles?: {
		readonly workers: (label: string) => Promise<readonly Worker[]>;
		readonly stop: (worker: Worker) => Promise<void>;
		/** The place of the host, whose store is the harness of the host. */
		readonly place: { readonly store: Pick<Harness, "observeCommits"> };
	};
};

const shared: Shared = {};

Object.assign(globalThis, { harnessLabels: shared });

/** The entry of the tests: it checks the label kind `fix`, and refuses `fix:no`. */
const LABELS_ENTRY = `export default function labelsEntry(handles) {
	globalThis.harnessLabels.handles = handles;
	return {
		extensions: [],
		labels: [
			{
				kind: "fix",
				check: async (label) => {
					if (label === "fix:no") throw new Error("The fixture refuses fix:no");
				},
			},
		],
		close: async () => {},
	};
}
`;

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	const module = join(root, "labels-entry.mjs");
	await writeFile(module, LABELS_ENTRY);
	setEntry("labels", module);
	setEntry("fixture", join(FIXTURE, "ask.ts"));
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

function handles(): NonNullable<Shared["handles"]> {
	if (shared.handles === undefined) throw new Error("no handles");

	return shared.handles;
}

/** Adds the todo `text` to the list of `handle`, and gives its ID. */
async function addTodo(handle: string, text: string): Promise<number> {
	return Value.Parse(Todo, await send({ type: "todo", caller: "cli", action: "add", handle, text })).id;
}

async function setTodo(handle: string, id: number, state: "done" | "dropped"): Promise<void> {
	await send({ type: "todo", caller: "cli", action: "set", handle, id, state });
}

/** Adds the open item `title`, and gives its ID. */
async function addItem(title: string): Promise<number> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "add", caller: "cli", title })).id;
}

async function setItem(id: number, state: "done" | "dropped"): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "set", caller: "cli", id, state }));
}

/** Sends `message` to the child `handle` of `caller`, with no push of its answers. */
async function sendTo(caller: string, handle: string, message: string): Promise<void> {
	await send({
		type: "send",
		requestId: `${caller}:${message}`,
		caller,
		handle,
		message,
		followUp: false,
		notify: false,
	});
}

/** Starts the task `key` of `fixture.ask`, whose child waits until the test opens the gate of `prompt`. */
async function startTask(key: string, prompt: string, extra: { labels?: string[]; serves?: SpawnServes } = {}) {
	const gate = Promise.withResolvers<void>();
	gates.set(prompt, gate);
	const input = extra.serves === undefined ? { cwd: root, prompt } : { cwd: root, prompt, serves: extra.serves };
	const start = { type: "start", kind: "fixture.ask", key, input } as const;
	await send(extra.labels === undefined ? start : { ...start, labels: extra.labels });
	await until(() => called(prompt) === 1);

	return gate;
}

/** The commits of the store while `run` runs. */
async function commitsDuring(run: () => Promise<void>): Promise<number> {
	let commits = 0;
	const observation = handles().place.store.observeCommits({ advance: () => (commits += 1), end: () => {} });

	try {
		await run();
	} finally {
		observation.detach();
	}

	return commits;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("a child ends only with its spawner", { timeout: 30_000 }, () => {
	it("ends a child with open todos when its spawner stops, and keeps a child whose todos are done", async () => {
		const agent = await spawnWithId("spawner-session");
		const child = (await spawnAs(agent.id, "Task:\nOpen child", { notify: false })).handle;
		await untilState(child, "idle");
		await addTodo(child, "Open work");
		const other = await spawnWithId("kept-session");
		await setTodo(other.handle, await addTodo(other.handle, "Done work"), "done");

		await send({ type: "stop", caller: "spawner-session", handle: agent.handle });
		await untilState(child, "ended");
		await sleep(300);
		expect(await stateOf(other.handle)).toBe("idle");
	});
});

describe("the workers of a label", { timeout: 30_000 }, () => {
	it("gives a running child, then an idle one, then a running task, and a second stop does nothing", async () => {
		const { workers, stop } = handles();
		gates.set("Fix busy", Promise.withResolvers());
		const agent = await spawnWithId("fix-session");
		const child = (await spawnAs(agent.id, "Task:\nFix child", { notify: false, labels: ["fix:a"] })).handle;
		await untilState(child, "idle");
		await sendTo(agent.id, child, "Fix busy");
		await until(() => called("Fix busy") === 1);

		const [running] = await workers("fix:a");
		expect(running).toEqual({ kind: "agent", handle: child, conversation: expect.any(String), state: "running" });

		if (running?.kind !== "agent") throw new Error("no agent");
		gates.get("Fix busy")?.resolve();
		await untilState(child, "idle");
		const idle: Worker = { ...running, state: "idle" };
		expect(await workers("fix:a")).toEqual([idle]);

		const gate = await startTask("fix-task", "Fix task", { labels: ["fix:a"] });
		const task: Worker = { kind: "task", key: "fix-task", state: "running" };
		expect(await workers("fix:a")).toEqual([idle, task]);
		expect(await send({ type: "status", handle: child })).toMatchObject({ labels: ["fix:a"] });

		await stop(task);
		expect(await send({ type: "task", key: "fix-task" })).toMatchObject({ status: "terminal" });
		expect(await commitsDuring(() => stop(idle))).toBeGreaterThan(0);
		await untilState(child, "ended");
		expect(await workers("fix:a")).toEqual([]);
		await sleep(300);

		expect(
			await commitsDuring(async () => {
				await stop(task);
				await stop(idle);
			}),
		).toBe(0);
		expect(await stateOf(agent.handle)).toBe("idle");
		gate.resolve();
	});

	it("refuses a spawn and a start with the reason of the check of a label, and leaves no child and no task", async () => {
		const parley = await framed("worker-ended");
		await answer([
			{ id: parley.call, answer: "a" },
			{ id: parley.readBack, answer: "ok" },
		]);
		await untilContract("worker-ended");
		await setItem(await contractItem("worker-ended"), "dropped");
		const done = await addItem("Already done");
		await setItem(done, "done");

		const caller = "refused-session";
		const labelled = (labels: string[]) => spawnAs(caller, `Task:\n${labels.join(" ")}`, { notify: false, labels });

		const serving = (serves: SpawnServes) =>
			spawnAs(caller, `Task:\n${JSON.stringify(serves)}`, { notify: false, serves });

		await expect(labelled(["fix:no"])).rejects.toThrow("The fixture refuses fix:no");
		await expect(labelled(["other:1"])).rejects.toThrow('no loaded entry checks the label kind "other"');
		await expect(serving({ parley: "nope" })).rejects.toThrow("Unknown parley: nope");
		await expect(serving({ item: 999 })).rejects.toThrow("Unknown item: 999");
		await expect(labelled(["item:x"])).rejects.toThrow("Unknown item: x");
		await expect(serving({ parley: "worker-ended" })).rejects.toThrow(
			"Parley worker-ended is dropped: an agent cannot serve it",
		);
		await expect(labelled([`item:${done}`])).rejects.toThrow(`Item ${done} is done: an agent cannot serve it`);
		expect(await send({ type: "list", caller })).toEqual([]);

		const start = { type: "start", kind: "fixture.ask" } as const;

		await expect(
			send({ ...start, key: "refused-fix", input: { cwd: root, prompt: "Refused fix" }, labels: ["fix:no"] }),
		).rejects.toThrow("The fixture refuses fix:no");
		await expect(
			send({ ...start, key: "refused-item", input: { cwd: root, prompt: "Refused item", serves: { item: done } } }),
		).rejects.toThrow(`Item ${done} is done: an agent cannot serve it`);
		await expect(send({ type: "task", key: "refused-fix" })).rejects.toThrow("Unknown task: refused-fix");
		await expect(send({ type: "task", key: "refused-item" })).rejects.toThrow("Unknown task: refused-item");
	});

	it("gives a task the label of the serves of its input, which refuses done while it is live", async () => {
		const item = await addItem("Task item");
		const gate = await startTask("item-task", "Item task", { serves: { item } });
		expect(await handles().workers(`item:${item}`)).toEqual([{ kind: "task", key: "item-task", state: "running" }]);
		expect(await send({ type: "item", action: "read", id: item })).toMatchObject({ stage: "building" });
		await expect(setItem(item, "done")).rejects.toThrow(
			`Item ${item} cannot be done: task item-task serves it and is live`,
		);

		gate.resolve();
		expect(await send({ type: "wait-task", key: "item-task" })).toMatchObject({ status: "terminal" });
		expect(await setItem(item, "done")).toMatchObject({ state: "done", stage: "done" });
	});
});

describe("the end of the work stops its workers", { timeout: 30_000 }, () => {
	it("stops a busy agent of an item with open todos, and its child, at once when the item is done", async () => {
		const item = await addItem("Busy item");
		const agent = await spawnWithId("busy-item-session", { serves: { item } });
		const child = (await spawnAs(agent.id, "Task:\nBusy item child", { notify: false })).handle;
		await untilState(child, "idle");
		await addTodo(agent.handle, "Open work");
		gates.set("Busy item work", Promise.withResolvers());
		await sendTo("busy-item-session", agent.handle, "Busy item work");
		await until(() => called("Busy item work") === 1);
		expect(await send({ type: "status", handle: agent.handle })).toMatchObject({
			state: "busy",
			labels: [`item:${item}`],
		});

		await setItem(item, "done");
		expect(await stateOf(agent.handle)).toBe("ended");
		expect(await stateOf(child)).toBe("ended");
		expect(aborted.has("Busy item work")).toBe(true);
	});

	it("keeps the agent of an open parley at its contract, and stops it when the contract ends", async () => {
		const parley = await framed("worker-parley");
		const agent = await spawnWithId("parley-session", { serves: { parley: "worker-parley" } });
		expect(await send({ type: "status", handle: agent.handle })).toMatchObject({ labels: ["parley:worker-parley"] });

		await answer([
			{ id: parley.call, answer: "a" },
			{ id: parley.readBack, answer: "ok" },
		]);
		await untilContract("worker-parley");
		await sleep(300);
		expect(await stateOf(agent.handle)).toBe("idle");

		await setItem(await contractItem("worker-parley"), "done");
		expect(await stateOf(agent.handle)).toBe("ended");
	});

	it("stops at the next start a worker that a message resumed after the end of its item", async () => {
		const item = await addItem("Resumed item");
		const agent = await spawnWithId("resumed-session", { serves: { item } });
		await setItem(item, "done");
		expect(await stateOf(agent.handle)).toBe("ended");

		await sendTo("resumed-session", agent.handle, "After the end");
		expect(await answerOf(agent.handle)).toBe("Answer to After the end");
		expect(await stateOf(agent.handle)).toBe("idle");

		await host?.close();
		host = await startHost();
		expect(await stateOf(agent.handle)).toBe("ended");
	});

	it("shows the labels of a child in the reply and the events of a watch", async () => {
		const item = await addItem("Watched item");
		const { handle } = await spawnAs("watch-session", "Task:\nWatched", { notify: false, serves: { item } });
		await untilState(handle, "idle");
		const watched = await openWatch({ kind: "child", handle });

		try {
			expect(watched.child.labels).toEqual([`item:${item}`]);
			await addTodo(handle, "Watched todo");
			await until(() => watched.lines.length > 0);
			expect(watched.lines.at(-1)?.child.labels).toEqual([`item:${item}`]);
		} finally {
			watched.client.close();
		}
	});

	it("takes --parley and --item in the CLI, and refuses two of them, an invalid item ID and --todo", async () => {
		const both = await cli(["spawn", "--parley", "worker-cli", "--item", "1", "--prompt", "Both"]);
		expect(both.stderr).toContain("A spawn serves one thing: give --parley or --item once");
		expect((await cli(["spawn", "--item", "0", "--prompt", "Zero"])).stderr).toContain("Invalid item id: 0");
		expect((await cli(["spawn", "--todo", "1", "--prompt", "Todo"])).stderr).toContain(
			"Unknown spawn argument: --todo",
		);

		await framed("worker-cli");
		const byParley = handleOf(await cli(["spawn", "--parley", "worker-cli", "--prompt", "Served by the CLI"]));
		const item = await addItem("Served by the CLI");
		const byItem = handleOf(await cli(["spawn", "--item", String(item), "--prompt", "Environment"]));
		const listed = new Map((await send({ type: "list", caller: "cli" })).map((child) => [child.handle, child.labels]));
		expect(listed.get(byParley)).toEqual(["parley:worker-cli"]);
		expect(listed.get(byItem)).toEqual([`item:${item}`]);
		expect(Value.Parse(StagedItem, await send({ type: "item", action: "read", id: item })).edges).toEqual([]);
	});
});
