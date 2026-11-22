import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommitChange, Harness } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { EntryOptions } from "../src/host/entries.ts";
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
	handles?: Pick<
		EntryOptions,
		"workers" | "stop" | "liveWorkers" | "labelledTasks" | "workersChange" | "labelChild" | "tell"
	> & {
		/** The place of the host, whose store is the harness of the host. */
		readonly place: { readonly store: Pick<Harness, "observeCommits"> };
	};
	/** The reports that the `reported` handler of the entry got, in order. */
	readonly reports: unknown[];
};

const shared: Shared = { reports: [] };

Object.assign(globalThis, { harnessLabels: shared });

/**
 * The entry of the tests: it checks the label kind `fix`, and refuses `fix:no`. It keeps each report, and throws for a
 * report with the reference `throw:me`.
 */
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
		reported: async (event) => {
			globalThis.harnessLabels.reports.push(event);
			if (event.refs.includes("throw:me")) throw new Error("The fixture refuses throw:me");
		},
		close: async () => {},
	};
}
`;

/** A commit reference. */
const COMMIT = `commit:${"a".repeat(40)}`;

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

/** The changes of the commits of the store while `run` runs. */
async function changesDuring(run: () => Promise<void>): Promise<CommitChange[]> {
	const changes: CommitChange[] = [];

	const observation = handles().place.store.observeCommits({
		advance: (publication) => changes.push(...publication.changes),
		end: () => {},
	});

	try {
		await run();
	} finally {
		observation.detach();
	}

	return changes;
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

	it("gives the live workers of each label, and the started tasks of each label in any state", async () => {
		const { liveWorkers, labelledTasks, stop } = handles();

		const child = (await spawnAs("each-session", "Task:\nEach child", { notify: false, labels: ["fix:b", "fix:c"] }))
			.handle;

		await untilState(child, "idle");
		const gate = await startTask("each-task", "Each task", { labels: ["fix:c"] });
		const agent: Worker = { kind: "agent", handle: child, conversation: expect.any(String), state: "idle" };
		const task: Worker = { kind: "task", key: "each-task", state: "running" };

		const live = await liveWorkers();
		expect(live.get("fix:b")).toEqual([agent]);
		expect(live.get("fix:c")).toEqual([agent, task]);
		expect((await labelledTasks()).get("fix:c")).toEqual(["each-task"]);
		expect((await labelledTasks()).has("fix:b")).toBe(false);

		await stop(task);
		await stop(agent);
		await untilState(child, "ended");
		expect((await liveWorkers()).has("fix:c")).toBe(false);
		expect((await labelledTasks()).get("fix:c")).toEqual(["each-task"]);
		gate.resolve();
	});

	it("marks the changes of a commit that can change a worker, and no other change", async () => {
		const { workersChange } = handles();

		const spawned = await changesDuring(async () => {
			const child = await spawnAs("change-session", "Task:\nChange child", { notify: false, labels: ["fix:d"] });
			await untilState(child.handle, "idle");
		});

		expect(spawned.some(workersChange)).toBe(true);

		const listed = await changesDuring(async () => {
			await addTodo("agent", "Not a worker");
		});

		expect(listed.length).toBeGreaterThan(0);
		expect(listed.some(workersChange)).toBe(false);
	});

	it("adds a label to a child by its conversation once, and finds no child for another conversation", async () => {
		const { labelChild, workers } = handles();
		const child = await spawnAs("label-session", "Task:\nLabel child", { notify: false, labels: ["fix:e"] });
		await untilState(child.handle, "idle");
		const [worker] = await workers("fix:e");

		if (worker?.kind !== "agent") throw new Error("no agent");
		expect(await labelChild(worker.conversation, "fix:late")).toBe(true);
		expect(await labelChild(worker.conversation, "fix:late")).toBe(true);
		expect(await labelChild("999999", "fix:late")).toBe(false);
		expect(await send({ type: "status", handle: child.handle })).toMatchObject({ labels: ["fix:e", "fix:late"] });
		expect(await workers("fix:late")).toEqual([worker]);
	});

	it("tells a hosted conversation an input, and gives another caller nothing", async () => {
		const { tell, workers } = handles();
		const child = await spawnAs("tell-session", "Task:\nTell child", { notify: false, labels: ["fix:f"] });
		await untilState(child.handle, "idle");
		const [worker] = await workers("fix:f");

		if (worker?.kind !== "agent") throw new Error("no agent");
		const conversation = worker.conversation;

		await tell(conversation, { type: "input", content: "Told input", requestId: "tell:1" });
		await until(() => called("Told input") === 1);
		await untilState(child.handle, "idle");
		await tell(conversation, { type: "input", content: "Told input", requestId: "tell:1" });
		await tell("pi-nobody", { type: "input", content: "Told nobody", requestId: "tell:2" });
		await sleep(300);
		expect(called("Told input")).toBe(1);
		expect(called("Told nobody")).toBe(0);
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

describe("a report of the result references of a worker", { timeout: 30_000 }, () => {
	it("lands a commit on the item of a task, sets the item done, and keeps the reporter live", async () => {
		const item = await addItem("Reported item");
		const gate = await startTask("report-task", "Report task", { labels: [`item:${item}`] });
		const refs = [COMMIT, "note:result"];

		expect(await send({ type: "report", caller: "report-caller", key: "report-task", refs })).toEqual({ refs });
		const read = Value.Parse(StagedItem, await send({ type: "item", action: "read", id: item }));
		expect(read.state).toBe("done");
		expect(read.edges).toEqual([
			{ from: `item:${item}`, kind: "landed", to: COMMIT, at: expect.any(Number), by: "report-caller" },
		]);
		expect(await send({ type: "task", key: "report-task" })).toMatchObject({ refs });
		const { nodes } = await send({ type: "tree" });
		expect(nodes.find((node) => node.id === "task:report-task")).toMatchObject({ kind: "run", refs });
		expect(shared.reports.at(-1)).toEqual({
			worker: { kind: "task", key: "report-task" },
			labels: [`item:${item}`],
			refs,
			caller: "report-caller",
		});

		await sleep(300);
		expect(await handles().workers(`item:${item}`)).toEqual([{ kind: "task", key: "report-task", state: "running" }]);
		gate.resolve();
		expect(await send({ type: "wait-task", key: "report-task" })).toMatchObject({ status: "terminal", refs });
	});

	it("writes one edge for a repeated report, and keeps a dropped item dropped", async () => {
		const item = await addItem("Twice reported");
		const gate = await startTask("twice-task", "Twice task", { labels: [`item:${item}`] });
		const report = { type: "report", caller: "cli", key: "twice-task" } as const;
		await send({ ...report, refs: [COMMIT] });
		expect(await send({ ...report, refs: [COMMIT, COMMIT] })).toEqual({ refs: [COMMIT] });
		expect(shared.reports.at(-1)).toMatchObject({ refs: [COMMIT, COMMIT] });
		const twice = Value.Parse(StagedItem, await send({ type: "item", action: "read", id: item }));
		expect(twice.state).toBe("done");
		expect(twice.edges).toHaveLength(1);
		gate.resolve();

		const dropped = await addItem("Dropped then reported");
		const late = await startTask("dropped-task", "Dropped task", { labels: [`item:${dropped}`] });
		await setItem(dropped, "dropped");
		await send({ type: "report", caller: "cli", key: "dropped-task", refs: [COMMIT] });
		const read = Value.Parse(StagedItem, await send({ type: "item", action: "read", id: dropped }));
		expect(read.state).toBe("dropped");
		expect(read.edges.map((edge) => edge.to)).toEqual([COMMIT]);
		late.resolve();
	});

	it("stores the references of a task with no item label, and changes no item", async () => {
		const item = await addItem("Untouched item");
		const bare = await startTask("bare-task", "Bare task");
		const fixed = await startTask("fixed-task", "Fixed task", { labels: ["fix:report"] });

		await send({ type: "report", caller: "cli", key: "bare-task", refs: [COMMIT] });
		await send({ type: "report", caller: "cli", key: "fixed-task", refs: [COMMIT] });
		expect(await send({ type: "task", key: "bare-task" })).toMatchObject({ refs: [COMMIT] });
		expect(shared.reports.at(-1)).toMatchObject({ labels: ["fix:report"] });
		expect(await send({ type: "item", action: "read", id: item })).toMatchObject({ state: "open", edges: [] });
		bare.resolve();
		fixed.resolve();
	});

	it("takes a child by handle or as the caller, refuses another caller, and fails with the handler of the entry", async () => {
		const agent = await spawnWithId("report-session");
		expect(await send({ type: "report", caller: "cli", handle: agent.handle, refs: ["note:one"] })).toEqual({
			refs: ["note:one"],
		});
		expect(await send({ type: "report", caller: agent.id, refs: ["note:two"] })).toEqual({
			refs: ["note:one", "note:two"],
		});
		expect(await send({ type: "status", handle: agent.handle })).toMatchObject({ refs: ["note:one", "note:two"] });

		await expect(send({ type: "report", caller: "cli", refs: ["note:x"] })).rejects.toThrow(
			"The caller is no worker of this host: give handle or key",
		);
		await expect(send({ type: "report", caller: "cli", key: "no-task", refs: ["note:x"] })).rejects.toThrow(
			"Unknown task: no-task",
		);
		await expect(send({ type: "report", caller: "cli", key: "x", refs: [] })).rejects.toThrow(
			"Invalid report request: refs:",
		);

		// Both workers at once: the type refuses it, so the line goes through JSON.
		const both = JSON.parse(
			JSON.stringify({ type: "report", caller: "cli", handle: agent.handle, key: "x", refs: ["a"] }),
		);

		await expect(send(both)).rejects.toThrow("Invalid report request: key: not allowed");
		await expect(send({ type: "report", caller: agent.id, handle: agent.handle, refs: ["throw:me"] })).rejects.toThrow(
			"The fixture refuses throw:me",
		);
		expect(await send({ type: "status", handle: agent.handle })).toMatchObject({
			refs: ["note:one", "note:two", "throw:me"],
		});
	});
});
