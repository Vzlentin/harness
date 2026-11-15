import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { Todo } from "../src/protocol/todo.ts";
import {
	aborted,
	answer,
	answerOf,
	called,
	cli,
	framed,
	gates,
	openWatch,
	round,
	send,
	setUp,
	spawnAs,
	spawnWithId,
	startHost,
	stateOf,
	tearDown,
	until,
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

/** Makes the parley `slug` of `framed` a contract. */
async function sign(parley: { readonly call: number; readonly readBack: number }): Promise<void> {
	await answer([
		{ id: parley.call, answer: "a" },
		{ id: parley.readBack, answer: "ok" },
	]);
}

/** Adds the todo `text` to the list of `handle`, and gives its ID. */
async function addTodo(handle: string, text: string): Promise<number> {
	return Value.Parse(Todo, await send({ type: "todo", caller: "cli", action: "add", handle, text })).id;
}

async function setTodo(handle: string, id: number, state: "done" | "dropped"): Promise<void> {
	await send({ type: "todo", caller: "cli", action: "set", handle, id, state });
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

		await sign(parley);
		await untilState(agent.handle, "ended");
		await untilState(child, "ended");
	});

	it("waits for the open and doing todos of the agent of a contract, and keeps it after a message", async () => {
		const parley = await framed("serve-contract");
		await sign(parley);

		const { handle } = await spawnAs("contract-session", "Task:\nServe contract", {
			notify: false,
			serves: { parley: "serve-contract" },
		});

		await untilState(handle, "idle");
		expect(await send({ type: "status", handle })).toMatchObject({
			serves: { kind: "contract", slug: "serve-contract" },
		});
		const todo = await addTodo(handle, "Save to the vault");
		await send({ type: "parley", action: "end", caller: "pi-1", slug: "serve-contract", status: "done" });
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

	it("ends a busy agent of a todo of the project at once when the todo is done", async () => {
		const todo = await addTodo(AGENT_HANDLE, "Serve busy");
		gates.set("Task:\nServe busy", Promise.withResolvers());

		const { handle } = await spawnAs("busy-session", "Task:\nServe busy", {
			notify: false,
			serves: { todo },
		});

		await until(() => called("Task:\nServe busy") === 1);
		expect(await send({ type: "status", handle })).toMatchObject({ state: "busy", serves: { kind: "todo", id: todo } });

		await setTodo(AGENT_HANDLE, todo, "done");
		await untilState(handle, "ended");
		expect(aborted.has("Task:\nServe busy")).toBe(true);
	});

	it("holds the answers of a child for an agent that the rule ended, until a message resumes it", async () => {
		const parley = await framed("serve-held");
		const agent = await spawnWithId("held-session", { serves: { parley: "serve-held" } });
		gates.set("Task:\nHeld child", Promise.withResolvers());
		const child = (await spawnAs(agent.id, "Task:\nHeld child", { notify: true })).handle;
		await until(() => called("Task:\nHeld child") === 1);
		await addTodo(child, "Keep me");

		await sign(parley);
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
		await sign(parley);
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

		await sign(parley);
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
		const todo = await addTodo(AGENT_HANDLE, "Serve watched");
		const { handle } = await spawnAs("watch-session", "Task:\nServe watched", { notify: false, serves: { todo } });
		await untilState(handle, "idle");
		const watched = await openWatch({ kind: "child", handle });

		try {
			expect(watched.child.serves).toEqual({ kind: "todo", id: todo });
			await addTodo(handle, "Watched todo");
			await until(() => watched.lines.length > 0);
			expect(watched.lines.at(-1)?.child.serves).toEqual({ kind: "todo", id: todo });
		} finally {
			watched.client.close();
		}
	});

	it("refuses a spawn for an unknown or ended parley or todo, and takes --parley and --todo in the CLI", async () => {
		const spawn = (serves: { parley: string } | { todo: number }) =>
			spawnAs("refused-session", "Task:\nRefused", { notify: false, serves });

		await expect(spawn({ parley: "nope" })).rejects.toThrow("Unknown parley: nope");
		await expect(spawn({ todo: 999 })).rejects.toThrow("Unknown todo: 999");
		const parley = await framed("serve-ended");
		await sign(parley);
		await send({ type: "parley", action: "end", caller: "pi-1", slug: "serve-ended", status: "dropped" });
		await expect(spawn({ parley: "serve-ended" })).rejects.toThrow(
			"Parley serve-ended is dropped: an agent cannot serve it",
		);
		const todo = await addTodo(AGENT_HANDLE, "Already done");
		await setTodo(AGENT_HANDLE, todo, "done");
		await expect(spawn({ todo })).rejects.toThrow(`Todo ${todo} is done: an agent cannot serve it`);

		const both = await cli(["spawn", "--parley", "serve-open", "--todo", "1", "--prompt", "Both"]);
		expect(both.stderr).toContain("A spawn serves one thing: give --parley or --todo once");
		await framed("serve-cli");
		expect((await cli(["spawn", "--parley", "serve-cli", "--prompt", "Served by the CLI"])).code).toBe(0);
		const [served] = await send({ type: "list", caller: "cli" });
		expect(served?.serves).toEqual({ kind: "parley", slug: "serve-cli" });
	});
});
