import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { todoTool } from "../src/tool.ts";
import {
	agentTurn,
	answerContent,
	cellResults,
	cli,
	gates,
	handleOf,
	listsOf,
	openDurableHost,
	openWatch,
	reports,
	requests,
	root,
	scripts,
	setSettings,
	setUp,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

/** The list of the child or the project agent `handle`. */
async function listOf(handle: string): Promise<Replies["todo"]> {
	const reply = await request({ type: "todo", caller: "cli", action: "list", handle }, { start: false });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/**
 * A pi-durable host over `store` with the `todo` tool, where the caller is `durable-todo:<conversation ID>`. With
 * `reached`, an `add` reaches the harness host, then calls `reached`, and the call never finishes.
 */
function openTodoHost(store: string, reached?: () => void): Promise<Harness> {
	const tool = todoTool(
		durable,
		{ Type },
		{
			caller: async (api) => `durable-todo:${api.conversationId}`,
			send: async (message, signal) => {
				const reply = await request(message, { start: false, signal });

				if (reply === undefined) throw new Error("no host");

				if (reached === undefined) return reply;
				reached();

				return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
			},
		},
	);

	return openDurableHost(store, [tool]);
}

describe("the todo tool", { timeout: 30_000 }, () => {
	it("changes the list of the child that calls it, and a watch of the child gets each change", async () => {
		const prompt = "Task:\nKeep todos";
		scripts.set(prompt, [
			{ name: "todo", arguments: { action: "add", text: "First step" } },
			{ name: "todo", arguments: { action: "set", id: 1, state: "doing" } },
		]);
		gates.set(prompt, Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Keep todos"]));
		const watched = await openWatch({ kind: "child", handle });

		try {
			gates.get(prompt)?.resolve();
			expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nTool said: ◉ 1 First step\n`);
			expect(cellResults.get(prompt)).toEqual(["○ 1 First step\n", "◉ 1 First step\n"]);

			const first = { id: 1, text: "First step", state: "open" };
			expect(await listOf(handle)).toEqual({ todos: [{ ...first, state: "doing" }] });
			await until(() => listsOf(watched.lines).length >= 2);
			expect(listsOf(watched.lines)).toEqual([{ todos: [first] }, { todos: [{ ...first, state: "doing" }] }]);
			expect(await listOf(AGENT_HANDLE)).toEqual({ todos: [] });
		} finally {
			watched.client.close();
		}
	});

	it("changes the list of the project with list project, and not the list of the child", async () => {
		scripts.set("Task:\nProject todo", [
			{ name: "todo", arguments: { action: "add", text: "For the project", list: "project" } },
		]);
		const handle = handleOf(await cli(["spawn", "--prompt", "Project todo"]));

		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nTool said: ○ 1 For the project\n`);
		expect(await listOf(AGENT_HANDLE)).toEqual({ todos: [{ id: 1, text: "For the project", state: "open" }] });
		expect(await listOf(handle)).toEqual({ todos: [] });
	});

	it("gives the project agent the tool", async () => {
		await agentTurn("Agent todo tools");

		expect(requests.get("Agent todo tools")?.tools).toContain("todo");
	});

	it("gives the tool to a child at the depth limit, which has no subagent tool", async () => {
		await setSettings({ agentDepthLimit: 1 });

		try {
			scripts.set("Task:\nLeaf todo", [{ name: "todo", arguments: { action: "add", text: "From a leaf" } }]);
			const handle = handleOf(await cli(["spawn", "--prompt", "Leaf todo"]));

			expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nTool said: ○ 1 From a leaf\n`);
			expect(requests.get("Task:\nLeaf todo")?.tools).toContain("todo");
			expect(requests.get("Task:\nLeaf todo")?.tools).not.toContain("subagent");
		} finally {
			await setSettings();
		}
	});

	it("does not run again a call that a restart interrupts, so an add is made once", async () => {
		reports.length = 0;
		const prompt = "Durable todo";
		scripts.set(prompt, [
			{ name: "todo", arguments: { action: "add", text: "Only once" } },
			{ name: "todo", arguments: { action: "list" } },
		]);
		const store = join(root, "durable-todo.sqlite");
		const reached = Promise.withResolvers<void>();
		let harness = await openTodoHost(store, reached.resolve);

		try {
			const conversation = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root },
			});

			const caller = `durable-todo:${conversation.id}`;
			const input = { type: "input", content: prompt, requestId: "durable-todo" } as const;
			await conversation.submit(input, context);
			await reached.promise;
			await harness.close(context);
			harness = await openTodoHost(store);
			harness.resume();
			const settled = await (await (await harness.root(context)).submit(input, context)).wait(context);

			expect(await answerContent(harness, settled)).toEqual([{ type: "text", text: "Tool said: ○ 1 Only once\n" }]);
			expect(cellResults.get(prompt)?.[0]).toContain("Tool todo was interrupted and may have partially run");
			const list: Extract<Request, { type: "todo" }> = { type: "todo", caller, action: "list" };
			expect(await request(list, { start: false })).toEqual({
				todos: [{ id: 1, text: "Only once", state: "open" }],
			});
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});
});
