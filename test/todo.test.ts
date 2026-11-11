import { mkdtemp, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { AGENT_HANDLE, type ListTarget } from "../src/protocol/target.ts";
import type { TodoState } from "../src/protocol/todo.ts";
import { cli, models, requests, root, setUp, spawnAs, startHost, tearDown, until } from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

/** The caller and the target of a list, as a `todo` request has them. */
type ListRef = { readonly caller: string } & ListTarget;

let host: Host | undefined;

/** Sends `line` to the host of `project` through the socket. */
async function send<T extends Request["type"]>(
	line: Extract<Request, { type: T }>,
	project?: string,
): Promise<Replies[T]> {
	const reply = await request(line, { start: false, project });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

function add(ref: ListRef, text: string, project?: string): Promise<Replies["todo"]> {
	return send({ type: "todo", action: "add", ...ref, text }, project);
}

function set(
	ref: ListRef,
	change: { readonly id: number; readonly state: TodoState; readonly text?: string },
): Promise<Replies["todo"]> {
	return send({ type: "todo", action: "set", ...ref, ...change });
}

function list(ref: ListRef, project?: string): Promise<Replies["todo"]> {
	return send({ type: "todo", action: "list", ...ref }, project);
}

/** Starts a `fixture.ask` task, waits for its outcome, and gives the conversation IDs of its child and its root. */
async function askTask(key: string): Promise<{ child: string; root: string }> {
	const idFile = join(root, `${key}.ids.json`);
	await send({ type: "start", kind: "fixture.ask", key, input: { cwd: root, prompt: `Todo ${key}`, idFile } });
	expect(await send({ type: "wait-task", key })).toMatchObject({ outcome: { status: "completed" } });

	return JSON.parse(await readFile(idFile, "utf8"));
}

beforeAll(async () => {
	await setUp();
	setEntry("fixture", join(FIXTURE, "ask.ts"));
	setEntry("todo-fixture", join(FIXTURE, "todo.ts"));
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("todo lists", { timeout: 30_000 }, () => {
	it("keeps one list for the project agent, a child, a library conversation and a caller", async () => {
		const child = await spawnAs("session-1", "Todo child", { notify: false });
		const ids = await askTask("lists");

		// The handle of a child needs no check of the caller, as for `watch`.
		const lists = {
			agent: { caller: "session-1", handle: AGENT_HANDLE },
			child: { caller: "session-2", handle: child.handle },
			conversation: { caller: "session-1", conversation: ids.child },
			caller: { caller: "session-3" },
		} satisfies Record<string, ListRef>;

		// The adds alternate between the lists, so a shared list would give other IDs.
		for (const [index, word] of ["one", "two", "three"].entries()) {
			for (const [name, ref] of Object.entries(lists)) {
				expect(await add(ref, `${name} ${word}`)).toEqual({ id: index + 1, text: `${name} ${word}`, state: "open" });
			}
		}

		for (const [name, ref] of Object.entries(lists)) {
			expect(await set(ref, { id: 2, state: "doing" })).toEqual({ id: 2, text: `${name} two`, state: "doing" });
			expect(await set(ref, { id: 3, state: "done", text: `${name} 3` })).toEqual({
				id: 3,
				text: `${name} 3`,
				state: "done",
			});
			expect(await list(ref)).toEqual({
				todos: [
					{ id: 1, text: `${name} one`, state: "open" },
					{ id: 2, text: `${name} two`, state: "doing" },
					{ id: 3, text: `${name} 3`, state: "done" },
				],
			});
		}
	});

	it("gives a caller that is a conversation of the host the list of its conversation", async () => {
		const ids = await askTask("caller");
		// A child that a task opens without tools gets the todo tool.
		expect(requests.get("Todo caller")?.tools).toContain("todo");
		const byConversation = { caller: "session-1", conversation: ids.child };
		const first = await add(byConversation, "Added by conversation");
		const second = await add({ caller: ids.child }, "Added by the caller");
		expect(await list(byConversation)).toEqual({ todos: [first, second] });
		expect(await list({ caller: ids.child })).toEqual(await list(byConversation));

		const agent = { caller: "session-1", handle: AGENT_HANDLE };
		const added = await add({ caller: "1" }, "Added by the project agent");
		expect(await list(agent)).toMatchObject({ todos: expect.arrayContaining([added]) });
		expect(await list({ caller: "1" })).toEqual(await list(agent));
	});

	it("keeps the list of a run that a task wrote in its last commit, also after a host restart", async () => {
		const key = "todo-run";
		await send({ type: "start", kind: "fixture.todo", key, input: { texts: ["first", "second", "third"] } });
		expect(await send({ type: "wait-task", key })).toMatchObject({
			status: "terminal",
			outcome: { status: "completed", result: null },
		});

		const run = { caller: "cli", key };

		const written = {
			todos: [
				{ id: 1, text: "first", state: "open" },
				{ id: 2, text: "second", state: "done" },
				{ id: 3, text: "third", state: "open" },
			],
		};

		expect(await list(run)).toEqual(written);
		await host?.close();
		host = await startHost();
		expect(await list(run)).toEqual(written);
		expect(await add(run, "fourth")).toEqual({ id: 4, text: "fourth", state: "open" });
	});

	it("refuses a bad request with a clear error, and leaves the list as it was", async () => {
		const own = { caller: "session-4" };
		await add(own, "Keep me");
		const before = await list(own);

		// The request types refuse these lines, so they go through JSON.
		const badState = JSON.parse(JSON.stringify({ type: "todo", ...own, action: "set", id: 1, state: "finished" }));
		await expect(send(badState)).rejects.toThrow("Invalid todo request: state is not valid");
		await expect(send({ ...badState, handle: AGENT_HANDLE })).rejects.toThrow(
			"Invalid todo request: state is not valid",
		);
		await expect(send({ ...badState, id: 0, state: "done" })).rejects.toThrow("Invalid todo request: id is not valid");
		const noText = JSON.parse(JSON.stringify({ type: "todo", ...own, action: "add" }));
		await expect(send(noText)).rejects.toThrow("Invalid todo request: text is required");
		const twoTargets = JSON.parse(JSON.stringify({ type: "todo", ...own, action: "list", handle: "agent", key: "x" }));
		await expect(send(twoTargets)).rejects.toThrow("Invalid todo request: key is not allowed");

		await expect(set(own, { id: 99, state: "done" })).rejects.toThrow("Unknown todo: 99");
		await expect(add(own, " \n")).rejects.toThrow("The text of a todo is empty");
		await expect(set(own, { id: 1, state: "dropped", text: "" })).rejects.toThrow("The text of a todo is empty");
		expect(await list(own)).toEqual(before);

		await expect(add({ ...own, handle: "nosuch" }, "No child")).rejects.toThrow("Unknown subagent: nosuch");

		// The root is not a conversation of the children library: its list is the one of the handle `agent`.
		for (const conversation of ["999999", "1"]) {
			await expect(add({ ...own, conversation }, "No conversation")).rejects.toThrow(
				`Unknown conversation: ${conversation}`,
			);
		}

		await expect(add({ ...own, key: "nope" }, "No task")).rejects.toThrow("Unknown task: nope");
		// A failed `set` on a list that does not exist yet leaves none.
		await expect(set({ caller: "session-5" }, { id: 1, state: "done" })).rejects.toThrow("Unknown todo: 1");
		expect(await list({ caller: "session-5" })).toEqual({ todos: [] });
	});

	it("keeps the list of the project agent when the agent gets no model", async () => {
		expect((await cli(["create", "bare", "--cwd", root])).code).toBe(0);
		const bare = await runHost({ project: "bare", cwd: root, models: createModels() });

		if (bare === undefined) throw new Error("no host");

		try {
			const agent = { caller: "cli", handle: AGENT_HANDLE };
			expect(await add(agent, "No model needed", "bare")).toEqual({ id: 1, text: "No model needed", state: "open" });
			expect(await list(agent, "bare")).toEqual({ todos: [{ id: 1, text: "No model needed", state: "open" }] });
		} finally {
			await bare.close();
		}
	});

	it("counts a change of a list as activity for the idle exit, and a list request not", async () => {
		const dir = await mkdtemp(join(root, "idle-"));
		expect((await cli(["create", "idle", "--cwd", dir])).code).toBe(0);
		// The host exits once it had no connection and no activity for 300 ms.
		const idle = await runHost({ project: "idle", cwd: dir, models, idleExitMs: 300 });

		if (idle === undefined) throw new Error("no host");
		let closed = false;
		void idle.closed.then(() => (closed = true));
		const own = { caller: "session-idle" };

		try {
			for (const end = Date.now() + 1000; Date.now() < end;) {
				await add(own, "Keep the host up", "idle");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			expect(closed).toBe(false);

			const polling = (async () => {
				while (!closed) {
					await list(own, "idle").catch(() => undefined);
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
