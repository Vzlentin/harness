import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
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

/** The conversation of the project agent: the root conversation, the first one of a new store. */
const AGENT_CALLER = "1";

/** One line of a tree watch: the reply, or an event. */
const WatchLine = Type.Union([
	Type.Object({ ok: Type.Literal(true), value: TreeReply }),
	Type.Object({ event: TreeEvent }),
]);

/** Runs the host of the new project `name` in this process. */
async function projectHost(name: string): Promise<Host> {
	const dir = await mkdtemp(join(root, `${name}-`));
	expect((await cli(["create", name, "--cwd", dir])).code).toBe(0);
	const host = await runHost({ project: name, cwd: dir, models });

	if (host === undefined) throw new Error("no host");

	return host;
}

/** Runs the host of the new project `name` with the entry `module` too, which the hosts started later do not load. */
async function projectHostWith(name: string, module: string): Promise<Host> {
	const entries = readEntries();
	setEntry(name, module);

	try {
		return await projectHost(name);
	} finally {
		await writeFile(entriesPath(), JSON.stringify(entries));
	}
}

/** Sends `line` to the host of `project` through the socket. */
async function send<T extends Request["type"]>(
	line: Extract<Request, { type: T }>,
	project: string,
): Promise<Replies[T]> {
	const reply = await request(line, { start: false, project });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/** Adds the todo `text` to the list `list` of the host of `project`. */
async function add(list: ListRef, text: string, project: string): Promise<void> {
	await send({ type: "todo", caller: "cli", action: "add", ...list, text }, project);
}

/** The nodes of the tree of `project`, checked against the reply schema. */
async function tree(project: string): Promise<TreeNode[]> {
	const reply = await send({ type: "tree" }, project);
	expect(Value.Check(TreeReply, reply)).toBe(true);

	return reply.nodes;
}

/** Starts the task `key` of `kind` with `input` in the host of `project`, and waits until it ends. */
async function runTask(
	project: string,
	kind: string,
	key: string,
	input: Extract<Request, { type: "start" }>["input"],
): Promise<Replies["start"]> {
	const started = await send({ type: "start", kind, key, input }, project);
	await send({ type: "wait-task", key }, project);

	return started;
}

function open(id: number, text: string): Todo {
	return { id, text, state: "open" };
}

/**
 * A `watch-tree` request of `project` on a socket of its own: its socket, the nodes of the reply, and the events that
 * came so far.
 */
async function openTreeWatch(project: string): Promise<{ socket: Socket; nodes: TreeNode[]; events: TreeEvent[] }> {
	const socket = createConnection(statePaths(project).socket);
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
	it("gives the project agent, a child, a started task and the conversation that the task owns, with their todos", async () => {
		const project = "four";
		const host = await projectHost(project);

		try {
			const child = await spawnAs(AGENT_CALLER, "Tree child", { notify: false, project });
			expect(await answerOf(child.handle, project)).toBe("Answer to Tree child");
			const idFile = join(root, "four.ids.json");
			const run = await runTask(project, "fixture.ask", "run", { cwd: root, prompt: "Tree task", idFile });
			const ids: { child: string; root: string } = JSON.parse(await readFile(idFile, "utf8"));
			expect(ids.root).toBe(AGENT_CALLER);

			await add({ handle: AGENT_HANDLE }, "Agent todo", project);
			await add({ handle: AGENT_HANDLE }, "Agent todo done", project);
			await send({ type: "todo", caller: "cli", action: "set", handle: AGENT_HANDLE, id: 2, state: "done" }, project);
			await add({ handle: child.handle }, "Child todo", project);
			await add({ key: "run" }, "Run todo", project);
			await add({ conversation: ids.child }, "Conversation todo", project);

			const nodes = await tree(project);

			expect(nodes).toEqual([
				{
					id: AGENT_HANDLE,
					kind: "agent",
					name: "four agent",
					state: "idle",
					todos: [open(1, "Agent todo"), { id: 2, text: "Agent todo done", state: "done" }],
				},
				{
					id: child.handle,
					parent: AGENT_HANDLE,
					kind: "agent",
					name: child.handle,
					state: "idle",
					todos: [open(1, "Child todo")],
				},
				{ id: "task:run", kind: "run", name: "fixture.ask run", state: "completed", todos: [open(1, "Run todo")] },
				{
					id: `conversation:${ids.child}`,
					parent: "task:run",
					kind: "agent",
					name: `fixture:${run.id}`,
					state: "idle",
					todos: [open(1, "Conversation todo")],
				},
			]);

			expect(await cli(["--project", project, "tree"])).toEqual({
				code: 0,
				stdout: [
					"○ four agent  idle  1 open",
					`  ○ ${child.handle}  idle  1 open`,
					"✓ fixture.ask run  completed  1 open",
					`  ○ fixture:${run.id}  idle  1 open`,
					"",
				].join("\n"),
				stderr: "",
			});
			expect(await cli(["--project", project, "tree", "--json"])).toEqual({
				code: 0,
				stdout: `${JSON.stringify({ nodes })}\n`,
				stderr: "",
			});
			expect(await cli(["--project", project, "tree", "--all"])).toMatchObject({
				code: 1,
				stderr: expect.stringContaining("  harness tree [--json]\n"),
			});
		} finally {
			await host.close();
		}
	});

	it("puts the child tasks of a started task under it", async () => {
		const project = "nested";
		const host = await projectHost(project);

		try {
			const deep = await runTask(project, "fixture.nest", "deep", { depth: 2, todo: "Nest" });
			const [agent, top, middle, bottom, ...rest] = await tree(project);
			expect(agent?.id).toBe(AGENT_HANDLE);
			expect(rest).toEqual([]);
			expect(top).toEqual({
				id: "task:deep",
				kind: "run",
				name: "fixture.nest deep",
				state: "completed",
				todos: [open(1, "Nest")],
			});

			const middleId = Number(middle?.id.replace(/^task:/, ""));
			const bottomId = Number(bottom?.id.replace(/^task:/, ""));
			expect(middleId).toBeGreaterThan(deep.id);
			expect(bottomId).toBeGreaterThan(middleId);
			expect(middle).toEqual({
				id: `task:${middleId}`,
				parent: "task:deep",
				kind: "run",
				name: `fixture.nest ${middleId}`,
				state: "completed",
				todos: [open(1, "Nest below")],
			});
			expect(bottom).toEqual({
				id: `task:${bottomId}`,
				parent: `task:${middleId}`,
				kind: "run",
				name: `fixture.nest ${bottomId}`,
				state: "completed",
				todos: [open(1, "Nest below below")],
			});
		} finally {
			await host.close();
		}
	});

	it("leaves out the nodes that ended before the 50 newest started tasks, with the nodes under them", async () => {
		const project = "window";
		const host = await projectHost(project);
		const prompt = "Window gate";
		const gate = Promise.withResolvers<void>();
		gates.set(prompt, gate);

		try {
			const idFile = join(root, "window.ids.json");
			await send({ type: "start", kind: "fixture.ask", key: "live", input: { cwd: root, prompt, idFile } }, project);
			await until(() => called(prompt) === 1);
			const ids: { child: string } = JSON.parse(await readFile(idFile, "utf8"));
			await runTask(project, "fixture.nest", "old", { depth: 0 });
			const recent = Array.from({ length: 50 }, (_, index) => `task:new-${index}`);

			for (const id of recent) await runTask(project, "fixture.nest", id.replace(/^task:/, ""), { depth: 0 });

			const live = await tree(project);
			expect(live.map((node) => node.id)).toEqual([AGENT_HANDLE, "task:live", `conversation:${ids.child}`, ...recent]);
			expect(live[1]).toMatchObject({ state: "running" });
			expect(live[2]).toMatchObject({ state: "busy" });

			gate.resolve();
			await send({ type: "wait-task", key: "live" }, project);
			expect((await tree(project)).map((node) => node.id)).toEqual([AGENT_HANDLE, ...recent]);
		} finally {
			gate.resolve();
			gates.delete(prompt);
			await host.close();
		}
	});

	it("sends the nodes that a commit changed, and the nodes that went, to a watch", async () => {
		const project = "watched";
		const host = await projectHost(project);
		const prompt = "Tree turn";
		const gate = Promise.withResolvers<void>();
		gates.set(prompt, gate);
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			const a = await spawnAs(AGENT_CALLER, "Watched A", { notify: false, project });
			const b = await spawnAs(AGENT_CALLER, "Watched B", { notify: false, project });
			await answerOf(a.handle, project);
			await answerOf(b.handle, project);
			watch = await openTreeWatch(project);
			const { events } = watch;
			expect(watch.nodes).toEqual(await tree(project));
			expect(watch.nodes.map((node) => node.id)).toEqual([AGENT_HANDLE, a.handle, b.handle]);

			await add({ handle: a.handle }, "Todo of A", project);
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
				project,
			);
			await until(() => statesOf(events, AGENT_HANDLE).includes("busy"));
			gate.resolve();
			await until(() => statesOf(events, AGENT_HANDLE).at(-1) === "idle");
			expect(statesOf(events, AGENT_HANDLE)).toEqual(["busy", "idle"]);
			expect(idsOf(events.slice(1)).every((id) => id === AGENT_HANDLE)).toBe(true);
			expect(events.some((event) => "removed" in event)).toBe(false);

			const c = await spawnAs(AGENT_CALLER, "Watched C", { notify: false, project });
			await answerOf(c.handle, project);
			await until(() => statesOf(events, c.handle).at(-1) === "idle");
			await send({ type: "stop", caller: AGENT_CALLER, handle: c.handle }, project);
			await until(() => events.some((event) => "removed" in event));
			expect(events.filter((event) => "removed" in event)).toEqual([{ removed: [c.handle] }]);
			expect(idsOf(events).filter((id) => id !== AGENT_HANDLE && id !== c.handle)).toEqual([a.handle]);
		} finally {
			gate.resolve();
			gates.delete(prompt);
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("sends the end of a run to a watch that opened while the tasks after the run ran", async () => {
		// pi-durable deletes the run after its after-run tasks in a commit that changes only the live document.
		const project = "after";
		const host = await projectHostWith(project, join(FIXTURE, "after-run.ts"));
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			const child = await spawnAs(AGENT_CALLER, "After-run child", { notify: false, project });
			await until(() => afterRun.waiting);
			watch = await openTreeWatch(project);
			const { events } = watch;
			expect(watch.nodes.find((node) => node.id === child.handle)).toMatchObject({ state: "busy" });

			// The event of this todo comes from a pass that ran before the gate opened, so a later pass sends the end.
			await add({ handle: AGENT_HANDLE }, "Agent todo", project);
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

	it("sends every node once to a watch that fell behind, and answers the other requests meanwhile", async () => {
		const project = "slow";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof openTreeWatch>> | undefined;

		try {
			const a = await spawnAs(AGENT_CALLER, "Slow A", { notify: false, project });
			const b = await spawnAs(AGENT_CALLER, "Slow B", { notify: false, project });
			await answerOf(a.handle, project);
			await answerOf(b.handle, project);
			watch = await openTreeWatch(project);
			const { events, socket } = watch;
			const large = "x".repeat(1_000_000);

			// The client reads nothing, so the host waits for the socket to drain after the event of the large todo.
			socket.pause();
			await add({ handle: a.handle }, large, project);
			await new Promise((resolve) => setTimeout(resolve, 300));
			await add({ handle: b.handle }, "After the large todo", project);
			await add({ handle: AGENT_HANDLE }, "Also after it", project);
			await new Promise((resolve) => setTimeout(resolve, 300));
			socket.resume();

			const index = () => events.findIndex((event) => "nodes" in event && JSON.stringify(event).includes(large));
			await until(() => index() !== -1 && events.length > index() + 1);
			const all = await tree(project);
			expect(events.slice(index() + 1)).toEqual([{ nodes: all }]);
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});
});
