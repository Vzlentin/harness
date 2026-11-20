import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ChildRecords } from "../src/host/records.ts";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { statePaths } from "../src/protocol/paths.ts";
import {
	agentTurn,
	calls,
	cellResults,
	cells,
	cli,
	gates,
	models,
	rawReply,
	root,
	setSettings,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

/** The entry with the `ipython` tool that follows the contract of pi-ipython. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ipython", "index.ts");

/** The caller of the project agent and of its kernel. */
const AGENT_CALLER = String(ROOT_CONVERSATION_ID);

/** The error of a call while no cell of its kernel runs. */
const NO_CELL = "No cell of this kernel runs: tools runs a tool only while a cell runs";

/** A cell that spawns a quiet child with `tools.subagent`, waits for it, and prints both results as JSON. */
const SPAWN_AND_WAIT = `import json
child = await tools.subagent(action="spawn", name="one", prompts=["Bridge child"], notify=False)
waited = await tools.subagent(action="wait", handle=child["value"]["handle"])
print(json.dumps([child, waited]))`;

/** A cell that waits for two children with `asyncio.gather`. The wait of B writes `gather-b-done` when it ends. */
const GATHER = `import asyncio, json
a = (await tools.subagent(action="spawn", prompts=["Bridge gather A"], notify=False))["value"]["handle"]
b = (await tools.subagent(action="spawn", prompts=["Bridge gather B"], notify=False))["value"]["handle"]
async def wait_b():
    waited = await tools.subagent(action="wait", handle=b)
    open("gather-b-done", "w").close()
    return waited["value"]["answer"]
async def wait_a():
    return (await tools.subagent(action="wait", handle=a))["value"]["answer"]
print(json.dumps(await asyncio.gather(wait_a(), wait_b())))`;

/** A cell that spawns a child that the caller waits for from the cell `prompt`, and prints its answer. */
const nest = (prompt: string) => `child = await tools.subagent(action="spawn", prompts=["${prompt}"], notify=False)
print((await tools.subagent(action="wait", handle=child["value"]["handle"]))["value"]["answer"])`;

let host: Host | undefined;

/** The handles of the children that the push test spawned, with and without `notify`. */
let loud = "";
let quiet = "";

/** The socket of the last kernel start of the server test. */
let lastSocket = "";

beforeAll(async () => {
	await setUp();
	setEntry("ipython", FIXTURE);
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the tools bridge in the kernels of the host", { timeout: 30_000 }, () => {
	it("spawns a child with tools.subagent and gives its answer with wait, for the cell's conversation", async () => {
		cells.set("Bridge wait", [SPAWN_AND_WAIT]);
		await agentTurn("Bridge wait");
		const [child, waited] = JSON.parse(cellResults.get("Bridge wait")?.[0] ?? "");

		expect(child).toMatchObject({ action: "spawn", value: { name: "one", provider: "faux", model: "faux-1" } });
		expect(waited).toEqual({ action: "wait", value: { answer: "Answer to Task:\nBridge child" } });

		// The caller is the conversation of the cell, as for its tool, so the CLI of that conversation sees the child.
		const listed = await cli(["list"], { PI_SESSION_ID: AGENT_CALLER });
		expect(listed.stdout).toContain(`one (${child.value.handle})`);
	});

	it("pushes the answer of a child spawned without notify, and not that of one spawned with notify=False", async () => {
		const parent = "Task:\nBridge push";

		cells.set(parent, [
			`loud = await tools.subagent(action="spawn", name="loud", prompts=["Bridge loud"])
quiet = await tools.subagent(action="spawn", name="quiet", prompts=["Bridge quiet"], notify=False)
print(loud["value"]["handle"], quiet["value"]["handle"])`,
		]);
		await spawnAs("bridge-push", parent, { notify: false });
		await until(() => cellResults.get(parent)?.length === 1);
		[loud = "", quiet = ""] = cellResults.get(parent)?.[0]?.trim().split(" ") ?? [];

		const header = `subagent loud (${loud}) finished`;
		await until(() => calls.some((call) => call.prompt.startsWith(header)));
		expect(calls.find((call) => call.prompt.startsWith(header))?.prompt).toBe(
			`${header}\n\nAnswer to Task:\nBridge loud`,
		);

		await until(() => calls.some((call) => call.prompt === "Task:\nBridge quiet"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(calls.filter((call) => call.prompt.startsWith(`subagent quiet (${quiet})`))).toEqual([]);
	});

	it("runs the tools of a leaf, which has no subagent tool", async () => {
		await setSettings({ agentDepthLimit: 2 });

		try {
			cells.set("Bridge nested", [nest("Bridge nest")]);
			cells.set("Task:\nBridge nest", [nest("Bridge leaf")]);
			cells.set("Task:\nBridge leaf", [
				`import json
from harness_tools import ToolError
print(json.dumps(await tools.todo(action="add", text="Leaf todo")))
try:
    await tools.subagent(action="list")
except ToolError as error:
    print(error)`,
			]);
			await agentTurn("Bridge nested");
		} finally {
			await setSettings();
		}

		expect(cellResults.get("Task:\nBridge leaf")).toEqual([
			'{"action": "add", "value": {"id": 1, "text": "Leaf todo", "state": "open"}}\nTool subagent is not available\n',
		]);
		expect(cellResults.get("Bridge nested")?.[0]).toContain("Tool said: Tool said: ");
	});

	it("raises ToolError with the text of the schema check, and for a tool that a cell cannot call", async () => {
		const cell = "Task:\nBridge refused";

		cells.set(cell, [
			`from harness_tools import ToolError
internal = getattr(tools, "pi.codemode.models.classify")
for call in (tools.subagent(action="wait", handle="abc123", timeout=0), tools.nothing(), internal(), tools.ipython(code="1")):
    try:
        await call
    except ToolError as error:
        print(error)`,
		]);
		await spawnAs("bridge-refused", cell, { notify: false });
		await until(() => cellResults.get(cell)?.length === 1);
		const [schema, unknown, internal, ipython] = cellResults.get(cell)?.[0]?.split(/\n(?=Tool |A cell )/) ?? [];

		expect(schema).toMatch(/^Validation failed for tool "subagent":\n {2}- timeout: /);
		expect(unknown).toBe("Tool nothing is not available");
		expect(internal).toBe("Tool pi.codemode.models.classify is not available");
		expect(ipython).toBe("A cell cannot run ipython: its kernel is busy with the cell\n");
	});

	it("raises for a call after its cell returned", async () => {
		const go = join(root, "bridge-go");
		const out = join(root, "bridge-late");

		cells.set("Bridge late", [
			`import asyncio, os, threading, time
def late():
    while not os.path.exists(${JSON.stringify(go)}):
        time.sleep(0.02)
    try:
        asyncio.run(tools.todo(action="list"))
        text = "ran"
    except Exception as error:
        text = str(error)
    with open(${JSON.stringify(out)}, "w") as file:
        file.write(text)
threading.Thread(target=late).start()`,
		]);
		await agentTurn("Bridge late");
		await writeFile(go, "");
		await until(() => existsSync(out));

		expect(readFileSync(out, "utf8")).toBe(NO_CELL);
	});

	it("gives the use of tools and the tools of the cell in tools.__doc__, and a tool's schema in its __doc__", async () => {
		const cell = "Task:\nBridge doc";
		cells.set(cell, ['print(tools.__doc__)\nprint("====")\nprint(tools.todo.__doc__)']);
		await spawnAs("bridge-doc", cell, { notify: false });
		await until(() => cellResults.get(cell)?.length === 1);
		const [doc = "", todo = ""] = cellResults.get(cell)?.[0]?.split("====\n") ?? [];

		expect(doc).toContain("`await tools.<name>(**args)`");
		expect(doc).toContain("\n- subagent: Spawn and manage subagents");
		expect(doc).toContain("\n- todo: Keep a list of todos");
		expect(doc).not.toContain("\n- ipython:");
		expect(doc).not.toContain("pi.codemode.");
		expect(todo).toMatch(/^Keep a list of todos/);
		expect(todo).toContain('Arguments, as JSON Schema:\n{\n  "type": "object"');
		expect(todo).toContain('"action"');
	});

	it("gives the structured result of the item tool to a cell", async () => {
		const cell = "Task:\nBridge item";

		cells.set(cell, [
			`import json
added = await tools.item(action="add", title="Bridge item")
read = await tools.item(action="read", id=added["value"]["id"])
print(json.dumps([added["action"], added["value"]["title"], added["value"]["stage"], read["action"], read["value"]["edges"]]))`,
		]);
		await spawnAs("bridge-item", cell, { notify: false });
		await until(() => cellResults.get(cell)?.length === 1);

		expect(cellResults.get(cell)).toEqual(['["add", "Bridge item", "inbox", "read", []]\n']);
	});

	it("runs the calls of asyncio.gather at the same time", async () => {
		const done = join(root, "home", "gather-b-done");
		const gate = Promise.withResolvers<void>();
		gates.set("Task:\nBridge gather A", gate);
		cells.set("Bridge gather", [GATHER]);
		const turn = agentTurn("Bridge gather");
		// B's wait ends while A's wait still runs.
		await until(() => existsSync(done));
		gate.resolve();
		await turn;

		expect(JSON.parse(cellResults.get("Bridge gather")?.[0] ?? "")).toEqual([
			"Answer to Task:\nBridge gather A",
			"Answer to Task:\nBridge gather B",
		]);
	});

	it("serves each kernel start on its own private socket, which refuses a wrong token", async () => {
		const cell = "Task:\nBridge server";

		cells.set(cell, [
			'import os\nprint(os.environ["HARNESS_TOOLS_SOCKET"])',
			"%restart",
			'import json, os\nprint(os.environ["HARNESS_TOOLS_SOCKET"])\nprint(json.dumps(await tools.todo(action="list")))',
		]);
		await spawnAs("bridge-server", cell, { notify: false });
		await until(() => cellResults.get(cell)?.length === 3);
		const [first, , second] = cellResults.get(cell) ?? [];
		const firstSocket = first?.trim() ?? "";
		const [secondSocket = "", listed] = second?.trim().split("\n") ?? [];
		expect(process.env.HARNESS_TOOLS_SOCKET).toBeUndefined();
		expect(firstSocket).toMatch(/^\/tmp\/harness-tools-[^/]+\/kernel\.sock$/);
		// The new kernel start replaced the server of the first one.
		expect(existsSync(dirname(firstSocket))).toBe(false);
		expect(secondSocket).toMatch(/^\/tmp\/harness-tools-[^/]+\/kernel\.sock$/);
		expect(secondSocket).not.toBe(firstSocket);
		expect(JSON.parse(listed ?? "")).toEqual({ action: "list", value: { todos: [] } });
		expect(statSync(dirname(secondSocket)).mode & 0o777).toBe(0o700);

		const line = JSON.stringify({ token: "wrong", name: "todo", args: { action: "list" } });
		expect(JSON.parse(await rawReply(secondSocket, line))).toEqual({ ok: false, error: "Invalid tools token" });
		lastSocket = secondSocket;
	});

	it("keeps the notify of each spawn of a cell, and removes the sockets when the host closes", async () => {
		await host?.close();
		expect(existsSync(dirname(lastSocket))).toBe(false);

		const store = await Harness.open(
			await openNodeSqliteStorage(join(statePaths("main").dir, "durable.sqlite")),
			{ models, registry: durable.createRegistry() },
			BACKGROUND_CONTEXT,
		);

		try {
			const state = await store.snapshot(ChildRecords, BACKGROUND_CONTEXT);
			expect(state?.children[loud]?.requests.map(({ notify }) => notify)).toEqual([true]);
			expect(state?.children[quiet]?.requests.map(({ notify }) => notify)).toEqual([false]);
		} finally {
			await store.close(BACKGROUND_CONTEXT);
			host = await startHost();
		}
	});
});
