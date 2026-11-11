import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { runTodoTool, sendToHost, todoToolSchemas } from "../src/tool.ts";
import { cli, setUp, spawnAs, startHost, tearDown } from "./helpers.ts";

const USAGE_LINE = "  harness todo [list | add <text> | set <id> <state> [--text <text>] | sort]\n";

let host: Host | undefined;

/** The output of `harness todo <args>`, which must succeed. */
async function todo(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
	const result = await cli(["todo", ...args], env);
	expect(result).toMatchObject({ code: 0, stderr: "" });

	return result.stdout;
}

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("harness todo", { timeout: 30_000 }, () => {
	it("adds, sets and lists the todos of the project", async () => {
		const project = ["--project-list"];
		expect(await todo(["add", "Move", "the", "config", ...project])).toBe("○ 1 Move the config\n");
		expect(await todo(["add", "Archive librlm", ...project])).toBe("○ 2 Archive librlm\n");
		expect(await todo([...project, "add", "Drop the old flag"])).toBe("○ 3 Drop the old flag\n");
		expect(await todo(["add", "Write the spec", ...project])).toBe("○ 4 Write the spec\n");
		expect(await todo(["set", "1", "doing", ...project])).toBe("◉ 1 Move the config\n");
		expect(await todo(["set", "2", "done", "--text", "Archive librlm and pi-rlm", ...project])).toBe(
			"✓ 2 Archive librlm and pi-rlm\n",
		);
		expect(await todo(["set", "3", "dropped", ...project])).toBe("✗ 3 Drop the old flag\n");

		const lines = "◉ 1 Move the config\n✓ 2 Archive librlm and pi-rlm\n✗ 3 Drop the old flag\n○ 4 Write the spec\n";
		expect(await todo(["list", ...project])).toBe(lines);
		expect(await todo(project)).toBe(lines);
		expect(await todo(["list", "--handle", "agent"])).toBe(lines);
	});

	it("keeps the list of each caller apart from the list of the project", async () => {
		const session = { PI_SESSION_ID: "session-1" };
		const projectList = await todo(["list", "--project-list"]);
		expect(await todo(["list"])).toBe("No todos\n");
		expect(await todo(["add", "Mine"])).toBe("○ 1 Mine\n");
		expect(await todo(["add", "Theirs"], session)).toBe("○ 1 Theirs\n");
		expect(await todo(["list"])).toBe("○ 1 Mine\n");
		expect(await todo([], session)).toBe("○ 1 Theirs\n");
		expect(await todo(["list", "--project-list"], session)).toBe(projectList);
	});

	it("reaches the list of a child with --handle", async () => {
		const child = await spawnAs("session-2", "Todo child", { notify: false });
		expect(await todo(["add", "From the CLI", "--handle", child.handle])).toBe("○ 1 From the CLI\n");

		const ref = { type: "todo", caller: "session-3", handle: child.handle } as const;
		expect(await request({ ...ref, action: "add", text: "From the request" }, { start: false })).toEqual({
			id: 2,
			text: "From the request",
			state: "open",
		});
		expect(await todo(["list", "--handle", child.handle])).toBe("○ 1 From the CLI\n○ 2 From the request\n");
	});

	it("refuses bad arguments with an error, and leaves the list as it was", async () => {
		const own = { PI_SESSION_ID: "session-errors" };
		expect(await todo(["add", "Keep me"], own)).toBe("○ 1 Keep me\n");

		const cases: [string[], string][] = [
			[["set", "1", "finished"], "Invalid todo state: finished\n"],
			[["set", "0", "done"], "Invalid todo id: 0\n"],
			[["set", "1.5", "done"], "Invalid todo id: 1.5\n"],
			[["set", "9", "done"], "Unknown todo: 9\n"],
			[["add", " "], "The text of a todo is empty\n"],
			[["set", "1", "done", "--text", " "], "The text of a todo is empty\n"],
			[["list", "--verbose"], "Unknown todo argument: --verbose\n"],
			[["list", "--handle"], "--handle requires a value\n"],
			[["add", "x", "--handle", "abcdef"], "Unknown subagent: abcdef\n"],
			[["add", "x", "--conversation", "999999"], "Unknown conversation: 999999\n"],
			[["add", "x", "--task", "nope"], "Unknown task: nope\n"],
		];

		const results = await Promise.all(cases.map(([args]) => cli(["todo", ...args], own)));
		expect(results.map(({ code, stderr }) => ({ code, stderr }))).toEqual(
			cases.map(([, stderr]) => ({ code: 1, stderr })),
		);

		const usages = [
			["add"],
			["set", "1"],
			["set", "1", "done", "extra"],
			["list", "extra"],
			["move"],
			["add", "x", "--text", "y"],
			["--handle", "agent", "--project-list"],
			["list", "--task", "a", "--conversation", "2"],
		];

		for (const args of usages) {
			const result = await cli(["todo", ...args], own);
			expect(result).toMatchObject({ code: 1, stdout: "" });
			expect(result.stderr).toMatch(/^Usage:/);
			expect(result.stderr).toContain(USAGE_LINE);
		}

		expect(await todo(["list"], own)).toBe("○ 1 Keep me\n");
	});

	it("gives the reply of the host as the data of a call of the todo tool", async () => {
		const scope = { caller: "session-tool", send: sendToHost, signal: undefined };
		const todoAdded = { id: 1, text: "By the tool", state: "open" };

		const added = await runTodoTool({ action: "add", text: "By the tool" }, scope, {});
		expect(added).toEqual({ text: "○ 1 By the tool\n", data: { action: "add", value: todoAdded } });
		const { output } = todoToolSchemas({ Type });
		expect(Value.Check(output, added.data)).toBe(true);
		expect(Value.Check(output, { action: "add", value: { ...todoAdded, state: "later" } })).toBe(false);
		expect(await runTodoTool({ action: "list" }, scope, {})).toEqual({
			text: "○ 1 By the tool\n",
			data: { action: "list", value: { todos: [todoAdded] } },
		});
	});
});
