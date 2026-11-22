import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { entriesPath, readEntries, setEntry } from "../src/protocol/entries.ts";
import { onLines } from "../src/protocol/lines.ts";
import { statePaths } from "../src/protocol/paths.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { AGENT_HANDLE, type ListRef } from "../src/protocol/target.ts";
import type { Todo } from "../src/protocol/todo.ts";
import { TreeEvent, type TreeNode, TreeReply } from "../src/protocol/tree.ts";
import { afterRun } from "./fixtures/tasks/after-run.ts";
import { answerOf, called, cli, gates, models, root, setUp, spawnAs, tearDown, until } from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

/** The conversation of the host agent: the root conversation, the first one of a new store. */
const AGENT_CALLER = "1";

/** One line of a tree watch: the reply, or an event. */
const WatchLine = Type.Union([
	Type.Object({ ok: Type.Literal(true), value: TreeReply }),
	Type.Object({ event: TreeEvent }),
]);

/** Runs the new host `name` in this process. */
async function newHost(name: string): Promise<Host> {
	const dir = await mkdtemp(join(root, `${name}-`));
	expect((await cli(["create", name, "--cwd", dir])).code).toBe(0);
	const host = await runHost({ host: name, cwd: dir, models });

	if (host === undefined) throw new Error("no host");

	return host;
}

/** Runs the new host `name` with the entry `module` too, which the hosts started later do not load. */
async function newHostWith(name: string, module: string): Promise<Host> {
	const entries = readEntries();
	setEntry(name, module);

	try {
		return await newHost(name);
	} finally {
		await writeFile(entriesPath(), JSON.stringify(entries));
	}
}

/** Sends `line` to the host `host` through the socket. */
async function send<T extends Request["type"]>(line: Extract<Request, { type: T }>, host: string): Promise<Replies[T]> {
	const reply = await request(line, { start: false, host });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/** Adds the todo `text` to the list `list` of the host `host`. */
async function add(list: ListRef, text: string, host: string): Promise<void> {
	await send({ type: "todo", caller: "cli", action: "add", ...list, text }, host);
}

/** The nodes of the tree of `host`, checked against the reply schema. */
async function tree(host: string): Promise<TreeNode[]> {
	const reply = await send({ type: "tree" }, host);
	expect(Value.Check(TreeReply, reply)).toBe(true);

	return reply.nodes;
}

/** Starts the task `key` of `kind` with `input` in the host `host`, and waits until it ends. */
async function runTask(
	host: string,
	kind: string,
	key: string,
	input: Extract<Request, { type: "start" }>["input"],
): Promise<Replies["start"]> {
	const started = await send({ type: "start", kind, key, input }, host);
	await send({ type: "wait-task", key }, host);

	return started;
}

function open(id: number, text: string): Todo {
	return { id, text, state: "open" };
}

/**
 * A `watch-tree` request of `host` on a socket of its own: its socket, the nodes of the reply, and the events that
 * came so far.
 */
async function openTreeWatch(host: string): Promise<{ socket: Socket; nodes: TreeNode[]; events: TreeEvent[] }> {
	const socket = createConnection(statePaths(host).socket);
	await once(socket, "connect");
	const replies: TreeReply[] = [];
	const events: TreeEvent[] = [];

	onLines(socket, (line) => {
		const parsed: unknown = JSON.parse(line);

		if (!Value.Check(WatchLine, parsed)) throw new Error(`not a line of a tree watch: ${line.slice(0, 200)}`);

		if ("ok" in parsed) replies.push(parsed.value);
		else events.push(parsed.event);
	});

	socket.write(`${JSON.stringify({ type: "watch-tree" })}\n`);
	await until(() => replies.length > 0);

	return { socket, nodes: replies[0]?.nodes ?? [], events };
}

/** The states of the node `id` in the `nodes` events of `events`, in order. */
function statesOf(events: readonly TreeEvent[], id: string): string[] {
	return events
		.flatMap((event) => ("nodes" in event ? event.nodes.filter((node) => node.id === id) : []))
		.map((node) => node.state);
}

/**
 * Starts the `fixture.ask` task `top` in `host`: it asks `above`, then starts a child task that asks `below`. Waits
 * until both asks are called, and gives the started task and the child conversations of the two asks.
 */
async function startHeldBelow(
	host: string,
	above: string,
	below: string,
): Promise<{ top: Replies["start"]; aboveChild: string; belowChild: string }> {
	const idFile = join(root, `${host}.ids.json`);
	const belowFile = join(root, `${host}.below.json`);
	const input = { cwd: root, prompt: above, idFile, below: { prompt: below, idFile: belowFile } };
	const top = await send({ type: "start", kind: "fixture.ask", key: "top", input }, host);
	await until(() => called(below) === 1 && called(above) === 1);
	const aboveIds: { child: string } = JSON.parse(await readFile(idFile, "utf8"));
	const belowIds: { child: string } = JSON.parse(await readFile(belowFile, "utf8"));

	return { top, aboveChild: aboveIds.child, belowChild: belowIds.child };
}

/** The IDs of the `removed` events of `events`. */
function removedOf(events: readonly TreeEvent[]): string[] {
	return events.flatMap((event) => ("removed" in event ? event.removed : []));
}

/** The IDs of the nodes of the `nodes` events of `events`. */
function idsOf(events: readonly TreeEvent[]): string[] {
	return events.flatMap((event) => ("nodes" in event ? event.nodes.map((node) => node.id) : []));
}

beforeAll(async () => {
	await setUp();
	setEntry("fixture", join(FIXTURE, "ask.ts"));
	setEntry("nest-fixture", join(FIXTURE, "nest.ts"));
});

afterAll(async () => {
	await tearDown();
});

describe("tree", { timeout: 60_000 }, () => {
	it("gives the host agent, a child, a live started task and the conversation that it owns, with their todos", async () => {
		const name = "four";
		const host = await newHost(name);
		const prompt = "Tree task";
		const gate = Promise.withResolvers<void>();
		gates.set(prompt, gate);

		try {
			const child = await spawnAs(AGENT_CALLER, "Tree child", { notify: false, host: name });
			expect(await answerOf(child.handle, name)).toBe("Answer to Tree child");
			const idFile = join(root, "four.ids.json");

			const run = await send(
				{ type: "start", kind: "fixture.ask", key: "run", input: { cwd: root, prompt, idFile } },
				name,
			);

			await until(() => called(prompt) === 1);
			const ids: { child: string; root: string } = JSON.parse(await readFile(idFile, "utf8"));
			expect(ids.root).toBe(AGENT_CALLER);

			await add({ handle: AGENT_HANDLE }, "Agent todo", name);
			await add({ handle: AGENT_HANDLE }, "Agent todo done", name);
			await send({ type: "todo", caller: "cli", action: "set", handle: AGENT_HANDLE, id: 2, state: "done" }, name);
			await add({ handle: child.handle }, "Child todo", name);
			await add({ key: "run" }, "Run todo", name);
			await add({ conversation: ids.child }, "Conversation todo", name);

			const agent: TreeNode = {
				id: AGENT_HANDLE,
				kind: "agent",
				name: "four agent",
				state: "idle",
				todos: [open(1, "Agent todo"), { id: 2, text: "Agent todo done", state: "done" }],
			};

			const spawned: TreeNode = {
				id: child.handle,
				parent: AGENT_HANDLE,
				kind: "agent",
				name: child.handle,
				state: "idle",
				todos: [open(1, "Child todo")],
			};

			const nodes = await tree(name);

			expect(nodes).toEqual([
				agent,
				spawned,
				{ id: "task:run", kind: "run", name: "fixture.ask run", state: "running", todos: [open(1, "Run todo")] },
				{
					id: `conversation:${ids.child}`,
					parent: "task:run",
					kind: "agent",
					name: `fixture:${run.id}`,
					state: "busy",
					todos: [open(1, "Conversation todo")],
				},
			]);

			expect(await cli(["--host", name, "tree"])).toEqual({
				code: 0,
				stdout: [
					"○ four agent  idle  1 open",
					`  ○ ${child.handle}  idle  1 open`,
					"◉ fixture.ask run  running  1 open",
					`  ◉ fixture:${run.id}  busy  1 open`,
					"",
				].join("\n"),
				stderr: "",
			});
			expect(await cli(["--host", name, "tree", "--json"])).toEqual({
				code: 0,
				stdout: `${JSON.stringify({ nodes })}\n`,
				stderr: "",
			});
			expect(await cli(["--host", name, "tree", "--all"])).toMatchObject({
				code: 1,
				stderr: expect.stringContaining("  harness tree [--json]\n"),
			});

			gate.resolve();
			await send({ type: "wait-task", key: "run" }, name);
			expect(await tree(name)).toEqual([
				agent,
				spawned,
				{ id: "task:run", kind: "run", name: "fixture.ask run", state: "completed", todos: [open(1, "Run todo")] },
			]);
		} finally {
			gate.resolve();
			gates.delete(prompt);
			await host.close();
		}
	});

	it("puts the child tasks of a live started task under it, with the conversations that they own", async () => {
		const name = "nested";
		const host = await newHost(name);
		const prompt = "Below gate";
		const gate = Promise.withResolvers<void>();
		gates.set(prompt, gate);

		try {
			const { top, aboveChild, belowChild } = await startHeldBelow(name, "Above", prompt);

			await vi.waitFor(
				async () => {
					const nodes = await tree(name);
					expect(nodes.find((node) => node.id === `conversation:${aboveChild}`)).toMatchObject({ state: "idle" });
				},
				{ timeout: 10_000 },
			);

			const [agent, run, task, belowConversation, aboveConversation, ...rest] = await tree(name);
			expect(agent?.id).toBe(AGENT_HANDLE);
			expect(rest).toEqual([]);
			expect(run).toEqual({ id: "task:top", kind: "run", name: "fixture.ask top", state: "running", todos: [] });
			const childId = Number(task?.id.replace(/^task:/, ""));
			expect(childId).toBeGreaterThan(top.id);
			expect(task).toEqual({
				id: `task:${childId}`,
				parent: "task:top",
				kind: "run",
				name: `fixture.ask ${childId}`,
				state: "running",
				todos: [],
			});
			expect(belowConversation).toEqual({
				id: `conversation:${belowChild}`,
				parent: `task:${childId}`,
				kind: "agent",
				name: `fixture:${childId}`,
				state: "busy",
				todos: [],
			});
			expect(aboveConversation).toEqual({
				id: `conversation:${aboveChild}`,
				parent: "task:top",
				kind: "agent",
				name: `fixture:${top.id}`,
				state: "idle",
				todos: [],
			});
		} finally {
			gate.resolve();
			gates.delete(prompt);
			await host.close();
		}
	});

	it("gives only the run node of a started task that ended, in the tree and in a watch", async () => {
		const name = "ended";
		const host = await newHost(name);
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			await runTask(name, "fixture.nest", "deep", { depth: 2, todo: "Nest" });
			const [agent, ...rest] = await tree(name);
			expect(agent?.id).toBe(AGENT_HANDLE);
			expect(rest).toEqual([
				{ id: "task:deep", kind: "run", name: "fixture.nest deep", state: "completed", todos: [open(1, "Nest")] },
			]);

			watch = await openTreeWatch(name);
			expect(watch.nodes).toEqual([agent, ...rest]);
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("leaves out the nodes that ended before the 50 newest started tasks, with the nodes under them", async () => {
		const name = "window";
		const host = await newHost(name);
		const prompt = "Window gate";
		const gate = Promise.withResolvers<void>();
		gates.set(prompt, gate);

		try {
			const idFile = join(root, "window.ids.json");
			await send({ type: "start", kind: "fixture.ask", key: "live", input: { cwd: root, prompt, idFile } }, name);
			await until(() => called(prompt) === 1);
			const ids: { child: string } = JSON.parse(await readFile(idFile, "utf8"));
			await runTask(name, "fixture.nest", "old", { depth: 0 });
			const recent = Array.from({ length: 50 }, (_, index) => `task:new-${index}`);

			for (const id of recent) await runTask(name, "fixture.nest", id.replace(/^task:/, ""), { depth: 0 });

			const live = await tree(name);
			expect(live.map((node) => node.id)).toEqual([AGENT_HANDLE, "task:live", `conversation:${ids.child}`, ...recent]);
			expect(live[1]).toMatchObject({ state: "running" });
			expect(live[2]).toMatchObject({ state: "busy" });

			gate.resolve();
			await send({ type: "wait-task", key: "live" }, name);
			expect((await tree(name)).map((node) => node.id)).toEqual([AGENT_HANDLE, ...recent]);
		} finally {
			gate.resolve();
			gates.delete(prompt);
			await host.close();
		}
	});

	it("sends the nodes that a commit changed to a watch, and keeps a stopped child as ended", async () => {
		const name = "watched";
		const host = await newHost(name);
		const prompt = "Tree turn";
		const gate = Promise.withResolvers<void>();
		gates.set(prompt, gate);
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			const a = await spawnAs(AGENT_CALLER, "Watched A", { notify: false, host: name });
			const b = await spawnAs(AGENT_CALLER, "Watched B", { notify: false, host: name });
			await answerOf(a.handle, name);
			await answerOf(b.handle, name);
			watch = await openTreeWatch(name);
			const { events } = watch;
			expect(watch.nodes).toEqual(await tree(name));
			expect(watch.nodes.map((node) => node.id)).toEqual([AGENT_HANDLE, a.handle, b.handle]);

			await add({ handle: a.handle }, "Todo of A", name);
			await until(() => events.length > 0);
			expect(events).toEqual([
				{
					nodes: [
						{
							id: a.handle,
							parent: AGENT_HANDLE,
							kind: "agent",
							name: a.handle,
							state: "idle",
							todos: [open(1, "Todo of A")],
						},
					],
				},
			]);

			await send(
				{ type: "input", requestId: "tree-turn", handle: AGENT_HANDLE, message: prompt, followUp: false },
				name,
			);
			await until(() => statesOf(events, AGENT_HANDLE).includes("busy"));
			gate.resolve();
			await until(() => statesOf(events, AGENT_HANDLE).at(-1) === "idle");
			expect(statesOf(events, AGENT_HANDLE)).toEqual(["busy", "idle"]);
			expect(idsOf(events.slice(1)).every((id) => id === AGENT_HANDLE)).toBe(true);
			expect(events.some((event) => "removed" in event)).toBe(false);

			const c = await spawnAs(AGENT_CALLER, "Watched C", { notify: false, host: name });
			await answerOf(c.handle, name);
			await until(() => statesOf(events, c.handle).at(-1) === "idle");
			await send({ type: "stop", caller: AGENT_CALLER, handle: c.handle }, name);
			await until(() => statesOf(events, c.handle).at(-1) === "ended");
			expect(events.some((event) => "removed" in event)).toBe(false);
			expect(idsOf(events).filter((id) => id !== AGENT_HANDLE && id !== c.handle)).toEqual([a.handle]);
		} finally {
			gate.resolve();
			gates.delete(prompt);
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("gives the labels of a child in its node, and sends the node to a watch when a stop ends it", async () => {
		const name = "labels-node";
		const host = await newHostWith(name, join(dirname(FIXTURE), "fix-labels.ts"));
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			const child = await spawnAs(AGENT_CALLER, "Labeled child", { notify: false, host: name, labels: ["fix:7"] });
			await answerOf(child.handle, name);
			watch = await openTreeWatch(name);
			const { events } = watch;

			const node = {
				id: child.handle,
				parent: AGENT_HANDLE,
				kind: "agent",
				name: child.handle,
				state: "idle",
				todos: [],
				labels: ["fix:7"],
			};

			expect(watch.nodes.find((found) => found.id === child.handle)).toEqual(node);
			await send({ type: "stop", caller: AGENT_CALLER, handle: child.handle }, name);
			await until(() => events.length > 0);
			expect(events).toEqual([{ nodes: [{ ...node, state: "ended" }] }]);
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("sends the end of a run to a watch that opened while the tasks after the run ran", async () => {
		// pi-durable deletes the run after its after-run tasks in a commit that changes only the live document.
		const name = "after";
		const host = await newHostWith(name, join(FIXTURE, "after-run.ts"));
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			const child = await spawnAs(AGENT_CALLER, "After-run child", { notify: false, host: name });
			await until(() => afterRun.waiting);
			watch = await openTreeWatch(name);
			const { events } = watch;
			expect(watch.nodes.find((node) => node.id === child.handle)).toMatchObject({ state: "busy" });

			// The event of this todo comes from a pass that ran before the gate opened, so a later pass sends the end.
			await add({ handle: AGENT_HANDLE }, "Agent todo", name);
			await until(() => idsOf(events).includes(AGENT_HANDLE));
			afterRun.gate.resolve();
			await until(() => statesOf(events, child.handle).length > 0);
			expect(statesOf(events, child.handle)).toEqual(["idle"]);
		} finally {
			afterRun.gate.resolve();
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("sends the nodes under a run as removed to a watch when the run ends", async () => {
		const name = "removed";
		const host = await newHost(name);
		const prompt = "Removed gate";
		const gate = Promise.withResolvers<void>();
		gates.set(prompt, gate);
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			const { aboveChild, belowChild } = await startHeldBelow(name, "Removed above", prompt);
			watch = await openTreeWatch(name);
			const { events } = watch;
			const task = watch.nodes.find((node) => node.parent === "task:top" && node.kind === "run");
			expect(task).toBeDefined();
			const under = [task?.id, `conversation:${belowChild}`, `conversation:${aboveChild}`];
			expect(watch.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(under));

			gate.resolve();
			await until(() => under.every((id) => id !== undefined && removedOf(events).includes(id)));
			expect(statesOf(events, "task:top").at(-1)).toBe("completed");
			expect((await tree(name)).map((node) => node.id)).toEqual([AGENT_HANDLE, "task:top"]);
		} finally {
			gate.resolve();
			gates.delete(prompt);
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("sends every node once to a watch that fell behind, and answers the other requests meanwhile", async () => {
		const name = "slow";
		const host = await newHost(name);
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			const a = await spawnAs(AGENT_CALLER, "Slow A", { notify: false, host: name });
			const b = await spawnAs(AGENT_CALLER, "Slow B", { notify: false, host: name });
			await answerOf(a.handle, name);
			await answerOf(b.handle, name);
			watch = await openTreeWatch(name);
			const { events, socket } = watch;
			const large = "x".repeat(1_000_000);

			// The client reads nothing, so the host waits for the socket to drain after the event of the large todo.
			socket.pause();
			await add({ handle: a.handle }, large, name);
			await new Promise((resolve) => setTimeout(resolve, 300));
			await add({ handle: b.handle }, "After the large todo", name);
			await add({ handle: AGENT_HANDLE }, "Also after it", name);
			await new Promise((resolve) => setTimeout(resolve, 300));
			socket.resume();

			const index = () => events.findIndex((event) => "nodes" in event && JSON.stringify(event).includes(large));
			await until(() => index() !== -1 && events.length > index() + 1);
			const all = await tree(name);
			expect(events.slice(index() + 1)).toEqual([{ nodes: all }]);
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});
});
