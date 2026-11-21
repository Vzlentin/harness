import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { StagedItem } from "../src/protocol/item.ts";
import type { ServesInput } from "../src/protocol/requests.ts";
import { Todo } from "../src/protocol/todo.ts";
import {
	aborted,
	answer,
	answerOf,
	called,
	cli,
	framed,
	gates,
	handleOf,
	openWatch,
	round,
	send,
	setUp,
	contractItem,
	spawnAs,
	spawnWithId,
	startHost,
	stateOf,
	tearDown,
	until,
	untilContract,
	untilState,
} from "./helpers.ts";

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

/** Makes the parley `slug` of `framed`, with the asks `parley`, a contract. */
async function sign(slug: string, parley: { readonly call: number; readonly readBack: number }): Promise<void> {
	await answer([
		{ id: parley.call, answer: "a" },
		{ id: parley.readBack, answer: "ok" },
	]);
	await untilContract(slug);
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

async function setItem(id: number, state: "done" | "dropped"): Promise<void> {
	await send({ type: "item", action: "set", caller: "cli", id, state });
}

async function readItem(id: number): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "read", id }));
}

/** The edge `agent:<conversation> serves item:<item>` that the caller `by` wrote, as `item read` gives it. */
function servesEdge(conversation: string, item: number, by: string) {
	return { from: `agent:${conversation}`, kind: "serves", to: `item:${item}`, at: expect.any(Number), by };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("an agent ends when what it serves ends", { timeout: 30_000 }, () => {
	it("ends the agent of a parley at its contract, and then the children that it spawned", async () => {
		const parley = await framed("serve-open");
		const agent = await spawnWithId("serve-session", { serves: { parley: "serve-open" } });
		const child = (await spawnAs(agent.id, "Task:\nServed child", { notify: false })).handle;
		await untilState(child, "idle");
		await sleep(300);
		expect(await stateOf(agent.handle)).toBe("idle");
		expect(await stateOf(child)).toBe("idle");
		expect(await send({ type: "status", handle: agent.handle })).toMatchObject({
			serves: { kind: "parley", slug: "serve-open" },
		});
		expect(await send({ type: "status", handle: child })).toMatchObject({ serves: { kind: "spawner" } });

		await sign("serve-open", parley);
		await untilState(agent.handle, "ended");
		await untilState(child, "ended");
	});

	it("waits for the open and doing todos of the agent of a contract, and keeps it after a message", async () => {
		const parley = await framed("serve-contract");
		await sign("serve-contract", parley);

		const { handle } = await spawnAs("contract-session", "Task:\nServe contract", {
			notify: false,
			serves: { parley: "serve-contract" },
		});

		await untilState(handle, "idle");
		expect(await send({ type: "status", handle })).toMatchObject({
			serves: { kind: "contract", slug: "serve-contract" },
		});
		const todo = await addTodo(handle, "Save to the vault");
		await setItem(await contractItem("serve-contract"), "done");
		expect(await send({ type: "parley", action: "read", slug: "serve-contract" })).toMatchObject({
			parley: { status: "done", by: "cli" },
		});
		await sleep(300);
		expect(await stateOf(handle)).toBe("idle");

		await setTodo(handle, todo, "done");
		await untilState(handle, "ended");
		await send({
			type: "send",
			requestId: "serve-contract-resume",
			caller: "contract-session",
			handle,
			message: "After the end",
			followUp: false,
			notify: false,
		});
		expect(await answerOf(handle)).toBe("Answer to After the end");
		await sleep(300);
		expect(await stateOf(handle)).toBe("idle");
	});

	it("writes the serves edge of an item at the spawn, and gives the item in the info and the tree", async () => {
		const item = await addItem("Serve edge");
		const agent = await spawnWithId("edge-session", { serves: { item } });
		expect(await readItem(item)).toMatchObject({
			edges: [servesEdge(agent.id, item, "edge-session")],
			stage: "building",
		});
		expect(await send({ type: "status", handle: agent.handle })).toMatchObject({ serves: { kind: "item", id: item } });
		expect((await send({ type: "list", caller: "edge-session" })).map((child) => child.serves)).toEqual([
			{ kind: "item", id: item },
		]);
		const { nodes } = await send({ type: "tree" });
		expect(nodes.find((node) => node.id === agent.handle)).toMatchObject({ serves: { kind: "item", id: item } });

		const again = await spawnAs("edge-session", "Task:\nEnvironment", { notify: false, serves: { item } });
		expect(again).toMatchObject({ handle: agent.handle, serves: { kind: "item", id: item } });
		expect((await readItem(item)).edges).toHaveLength(1);
	});

	it("ends a busy agent of an item at once when the item is done", async () => {
		const item = await addItem("Serve busy");
		gates.set("Task:\nServe busy", Promise.withResolvers());

		const { handle } = await spawnAs("busy-session", "Task:\nServe busy", {
			notify: false,
			serves: { item },
		});

		await until(() => called("Task:\nServe busy") === 1);
		expect(await send({ type: "status", handle })).toMatchObject({ state: "busy", serves: { kind: "item", id: item } });

		await setItem(item, "done");
		await untilState(handle, "ended");
		expect(aborted.has("Task:\nServe busy")).toBe(true);
	});

	it("waits for the open todos of the agent of an item, keeps the agent of another item, and takes dropped", async () => {
		const item = await addItem("Serve todos");
		const other = await addItem("Serve other");
		const agent = await spawnWithId("item-todos-session", { serves: { item } });
		const bystander = await spawnWithId("item-other-session", { serves: { item: other } });
		const todo = await addTodo(agent.handle, "Finish the item");

		await setItem(item, "done");
		await sleep(300);
		expect(await stateOf(agent.handle)).toBe("idle");

		await setTodo(agent.handle, todo, "done");
		await untilState(agent.handle, "ended");
		expect(await stateOf(bystander.handle)).toBe("idle");

		await setItem(other, "dropped");
		await untilState(bystander.handle, "ended");
	});

	it("gives no serves for an agent whose edge was unlinked, and does not end it when the item is done", async () => {
		const item = await addItem("Serve unlinked");
		const agent = await spawnWithId("unlinked-session", { serves: { item } });
		const edge = { from: `agent:${agent.id}`, kind: "serves", to: `item:${item}` } as const;
		await send({ type: "item", action: "unlink", caller: "cli", ...edge });
		expect(await send({ type: "status", handle: agent.handle })).not.toHaveProperty("serves");

		await setItem(item, "done");
		await sleep(300);
		expect(await stateOf(agent.handle)).toBe("idle");
	});

	it("holds the answers of a child for an agent that the rule ended, until a message resumes it", async () => {
		const parley = await framed("serve-held");
		const agent = await spawnWithId("held-session", { serves: { parley: "serve-held" } });
		gates.set("Task:\nHeld child", Promise.withResolvers());
		const child = (await spawnAs(agent.id, "Task:\nHeld child", { notify: true })).handle;
		await until(() => called("Task:\nHeld child") === 1);
		await addTodo(child, "Keep me");

		await sign("serve-held", parley);
		await untilState(agent.handle, "ended");
		gates.get("Task:\nHeld child")?.resolve();
		await untilState(child, "idle");
		await sleep(300);
		expect(await stateOf(agent.handle)).toBe("ended");
		expect(await stateOf(child)).toBe("idle");

		await send({
			type: "send",
			requestId: "serve-held-resume",
			caller: "held-session",
			handle: agent.handle,
			message: "Resume held",
			followUp: false,
			notify: false,
		});
		await until(() => called(`subagent ${child} finished\n\nAnswer to Task:\nHeld child`) === 1);
	});

	it("lets the answer of the user resume an agent that the rule ended", async () => {
		const parley = await framed("serve-asked");
		const agent = await spawnWithId("asked-session", { serves: { parley: "serve-asked" } });
		const [ask] = (await round(agent.id, undefined, [{ title: "Served ask" }])).asks;

		if (ask === undefined) throw new Error("no ask");
		await sign("serve-asked", parley);
		await untilState(agent.handle, "ended");

		await answer([{ id: ask.id, answer: "own", label: "Go" }]);
		await until(() => called(`the user answered ask ${ask.id}\n\n${ask.id} · Served ask · own · Go\n`) === 1);
		await untilState(agent.handle, "idle");
	});

	it("lets the answer of the user resume a child that a stop ended with its spawner", async () => {
		const agent = await spawnWithId("stopped-session");
		const child = await spawnWithId(agent.id);
		const [lone] = (await round(child.id, undefined, [{ title: "Stopped lone" }])).asks;

		if (lone === undefined) throw new Error("no ask");
		await send({ type: "stop", caller: "stopped-session", handle: agent.handle });
		await untilState(child.handle, "ended");
		await sleep(300);

		await answer([{ id: lone.id, answer: "own", label: "Go" }]);
		await until(() => called(`the user answered ask ${lone.id}\n\n${lone.id} · Stopped lone · own · Go\n`) === 1);
		await untilState(child.handle, "idle");
		expect(await stateOf(agent.handle)).toBe("ended");
	});

	it("waits for the todos of the agent of an open parley, then for those of its child, and takes dropped", async () => {
		const parley = await framed("serve-todos");
		const agent = await spawnWithId("todos-session", { serves: { parley: "serve-todos" } });
		const child = (await spawnAs(agent.id, "Task:\nTodo child", { notify: false })).handle;
		await untilState(child, "idle");
		const agentTodo = await addTodo(agent.handle, "Finish the plan");
		const childTodo = await addTodo(child, "Finish the step");

		await sign("serve-todos", parley);
		await sleep(300);
		expect(await stateOf(agent.handle)).toBe("idle");

		await setTodo(agent.handle, agentTodo, "dropped");
		await untilState(agent.handle, "ended");
		await sleep(300);
		expect(await stateOf(child)).toBe("idle");

		await setTodo(child, childTodo, "done");
		await untilState(child, "ended");
	});

	it("shows what a child serves in the reply and the events of a watch", async () => {
		const item = await addItem("Serve watched");
		const { handle } = await spawnAs("watch-session", "Task:\nServe watched", { notify: false, serves: { item } });
		await untilState(handle, "idle");
		const watched = await openWatch({ kind: "child", handle });

		try {
			expect(watched.child.serves).toEqual({ kind: "item", id: item });
			await addTodo(handle, "Watched todo");
			await until(() => watched.lines.length > 0);
			expect(watched.lines.at(-1)?.child.serves).toEqual({ kind: "item", id: item });
		} finally {
			watched.client.close();
		}
	});

	it("refuses a spawn for an unknown or ended parley or item, and opens no child", async () => {
		const spawn = (serves: ServesInput) => spawnAs("refused-session", "Task:\nRefused", { notify: false, serves });

		await expect(spawn({ parley: "nope" })).rejects.toThrow("Unknown parley: nope");
		await expect(spawn({ item: 999 })).rejects.toThrow("Unknown item: 999");
		const parley = await framed("serve-ended");
		await sign("serve-ended", parley);
		await setItem(await contractItem("serve-ended"), "dropped");
		await expect(spawn({ parley: "serve-ended" })).rejects.toThrow(
			"Parley serve-ended is dropped: an agent cannot serve it",
		);
		const item = await addItem("Already done");
		await setItem(item, "done");
		await expect(spawn({ item })).rejects.toThrow(`Item ${item} is done: an agent cannot serve it`);
		expect(await send({ type: "list", caller: "refused-session" })).toEqual([]);
		expect((await readItem(item)).edges).toEqual([]);
	});

	it("takes --parley and --item in the CLI, and refuses two of them, an invalid item ID and --todo", async () => {
		const both = await cli(["spawn", "--parley", "serve-open", "--item", "1", "--prompt", "Both"]);
		expect(both.stderr).toContain("A spawn serves one thing: give --parley or --item once");
		expect((await cli(["spawn", "--item", "0", "--prompt", "Zero"])).stderr).toContain("Invalid item id: 0");
		expect((await cli(["spawn", "--todo", "1", "--prompt", "Todo"])).stderr).toContain(
			"Unknown spawn argument: --todo",
		);

		await framed("serve-cli");
		const byParley = handleOf(await cli(["spawn", "--parley", "serve-cli", "--prompt", "Served by the CLI"]));
		const item = await addItem("Served by the CLI");
		const spawned = await cli(["spawn", "--item", String(item), "--prompt", "Environment"]);
		expect(spawned.code).toBe(0);
		const byItem = handleOf(spawned);
		const id = /^Tool said: (\d+) /m.exec((await cli(["wait", byItem])).stdout)?.[1];

		if (id === undefined) throw new Error("no conversation ID");
		expect((await readItem(item)).edges).toEqual([servesEdge(id, item, "cli")]);
		const listed = new Map((await send({ type: "list", caller: "cli" })).map((child) => [child.handle, child.serves]));
		expect(listed.get(byParley)).toEqual({ kind: "parley", slug: "serve-cli" });
		expect(listed.get(byItem)).toEqual({ kind: "item", id: item });
	});
});
