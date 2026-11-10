import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { ChildRecords } from "../src/host/records.ts";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { runTool, sendToHost, toolSchemas } from "../src/tool.ts";
import {
	aborted,
	agentTurn,
	answerOf,
	called,
	cellResults,
	cells,
	cli,
	gates,
	handleOf,
	models,
	rawReply,
	requests,
	root,
	setDepthLimit,
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

/** A cell that runs each action of `rlm` and prints the results as JSON. */
const TOUR = `import json
one = await rlm.spawn("RLM one", context="Context text", name="one")
two = await rlm.spawn("RLM two", model="faux/faux-2")
first = await rlm.wait(one)
sent = await rlm.send(one, "RLM again")
again = await rlm.wait(one["handle"])
status = await rlm.status(two)
renamed = await rlm.rename(one, "first")
stopped = await rlm.stop(two)
listed = await rlm.list()
print(json.dumps(dict(one=one, two=two, first=first, sent=sent, again=again, status=status, renamed=renamed, stopped=stopped, listed=listed)))`;

/** A cell that waits for two children with `asyncio.gather`. The wait of B writes `gather-b-done` when it ends. */
const GATHER = `import asyncio, json
a = await rlm.spawn("RLM gather A")
b = await rlm.spawn("RLM gather B")
async def wait_b():
    answer = await rlm.wait(b)
    open("gather-b-done", "w").close()
    return answer
print(json.dumps(await asyncio.gather(rlm.wait(a), wait_b())))`;

let host: Host | undefined;

/** The handles of the children of the tour, and of a child that the CLI spawned. */
let one = "";
let two = "";
let failing = "";

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

describe("rlm in the kernels of the host", { timeout: 30_000 }, () => {
	it("runs the subagent actions from a cell, on the children of the cell's conversation", async () => {
		cells.set("RLM tour", [TOUR]);
		await agentTurn("RLM tour");
		const tour = JSON.parse(cellResults.get("RLM tour")?.[0] ?? "");
		one = tour.one.handle;
		two = tour.two.handle;
		expect(tour.one).toMatchObject({ name: "one", provider: "faux", model: "faux-1", kind: "rlm" });
		expect(tour.two).toMatchObject({ provider: "faux", model: "faux-2" });
		expect(tour.first).toBe("Answer to Task:\nRLM one\n\n<context>\nContext text\n</context>");
		expect(tour.sent).toMatchObject({ verb: "Prompted", child: { handle: one } });
		expect(tour.again).toBe("Answer to RLM again");
		expect(tour.status).toMatchObject({ handle: two, model: "faux-2" });
		expect(tour.renamed).toMatchObject({ handle: one, name: "first" });
		expect(tour.stopped).toEqual({ handle: two });
		expect(tour.listed.map((child: { handle: string }) => child.handle)).toEqual([one]);

		// The kernel's caller is its conversation, as for the tool, so the CLI of that conversation sees the same children.
		const listed = await cli(["list"], { PI_SESSION_ID: AGENT_CALLER });
		expect([...listed.stdout.matchAll(/\(([a-z0-9]+)\)/g)].map((match) => match[1])).toEqual([one]);
		expect((await cli(["status", one], { PI_SESSION_ID: AGENT_CALLER })).stdout).toBe(
			`first (${one}): idle (faux/faux-1, ${tour.one.thinking})\n`,
		);
		expect((await cli(["status", two])).stderr).toBe(`Unknown subagent: ${two}\n`);
		expect(requests.get("RLM tour")?.tools).toContain("ipython");
		expect(requests.get("RLM tour")?.system).not.toContain("<rlm>");
	});

	it("marks the RLM children of a caller in list, in its text and its data, apart from its other children", async () => {
		const sub = await spawnAs(AGENT_CALLER, "Task:\nRLM plain sibling", { notify: false });
		await answerOf(sub.handle);
		const status = await request({ type: "status", handle: one }, { start: false });
		expect(status).toMatchObject({ handle: one, kind: "rlm" });

		const lines = `first (${one})  idle      faux/faux-1  ${status?.thinking}  rlm\n${sub.handle}  idle      faux/faux-1  medium\n`;
		expect((await cli(["list"], { PI_SESSION_ID: AGENT_CALLER })).stdout).toBe(lines);

		const scope = {
			caller: AGENT_CALLER,
			callKey: "rlm-list",
			provider: "faux",
			model: "faux-1",
			thinking: "medium",
			cwd: root,
			send: sendToHost,
			signal: undefined,
		};

		const listed = await runTool({ action: "list" }, scope);
		expect(listed.text).toBe(lines);
		const children = listed.data.action === "list" ? listed.data.value : [];
		expect(children.map(({ handle }) => handle)).toEqual([one, sub.handle]);
		expect(children[0]).toEqual(status);
		expect(children[1]).not.toHaveProperty("kind");

		const { output } = toolSchemas({ Type });
		expect(Value.Check(output, listed.data)).toBe(true);
		expect(Value.Check(output, { action: "list", value: [{ ...children[0], kind: "other" }] })).toBe(false);
	});

	it("runs the waits of asyncio.gather at the same time", async () => {
		const done = join(root, "home", "gather-b-done");
		const gate = Promise.withResolvers<void>();
		gates.set("Task:\nRLM gather A", gate);
		cells.set("RLM gather", [GATHER]);
		const turn = agentTurn("RLM gather");
		// B's wait ends while A's wait still runs.
		await until(() => existsSync(done));
		gate.resolve();
		await turn;

		expect(JSON.parse(cellResults.get("RLM gather")?.[0] ?? "")).toEqual([
			"Answer to Task:\nRLM gather A",
			"Answer to Task:\nRLM gather B",
		]);
	});

	it("keeps the children of a failed cell, so a wait in the next cell gives their answers", async () => {
		const gate = Promise.withResolvers<void>();
		gates.set("Task:\nRLM survivor", gate);
		cells.set("Task:\nRLM fails", [
			'h = await rlm.spawn("RLM survivor")\nraise RuntimeError("boom")',
			"print(await rlm.wait(h))",
		]);
		failing = handleOf(await cli(["spawn", "--prompt", "RLM fails"]));
		await until(() => cellResults.get("Task:\nRLM fails")?.length === 1);
		expect(cellResults.get("Task:\nRLM fails")?.[0]).toContain("RuntimeError: boom");
		await until(() => called("Task:\nRLM survivor") === 1);
		gate.resolve();
		expect((await cli(["wait", failing])).stdout).toContain("Tool said: Answer to Task:\nRLM survivor\n");
	});

	it("closes the children of a kernel with their conversation, and they do not hold it", async () => {
		gates.set("Task:\nRLM held", Promise.withResolvers());
		cells.set("Task:\nRLM parent", ['print((await rlm.spawn("RLM held"))["handle"])']);
		const parent = handleOf(await cli(["spawn", "--prompt", "RLM parent"]));
		// A notify child would hold its parent, and this wait would end only after the gate.
		const held = /Tool said: ([a-z0-9]+)/.exec((await cli(["wait", parent])).stdout)?.[1] ?? "";
		expect((await cli(["status", held])).stdout).toMatch(new RegExp(`^${held}: busy `));
		expect((await cli(["stop", parent])).stdout).toBe(`Stopped ${parent}\n`);
		await until(() => aborted.has("Task:\nRLM held"));
		expect((await cli(["status", held])).stderr).toBe(`Unknown subagent: ${held}\n`);
	});

	it("gives a child at the depth limit no rlm in its kernel", async () => {
		await setDepthLimit(2);

		try {
			cells.set("RLM nested", ['print(await rlm.wait(await rlm.spawn("RLM nest")))']);
			cells.set("Task:\nRLM nest", ['print(await rlm.wait(await rlm.spawn("RLM leaf")))']);
			cells.set("Task:\nRLM leaf", ['print("rlm" in globals())']);
			await agentTurn("RLM nested");
		} finally {
			await setDepthLimit(undefined);
		}

		expect(cellResults.get("Task:\nRLM leaf")?.map((text) => text.trim())).toEqual(["False"]);
		expect(cellResults.get("RLM nested")?.[0]).toContain("Tool said: Tool said: False");
		expect(requests.get("Task:\nRLM leaf")?.tools).toContain("ipython");
		expect(requests.get("Task:\nRLM leaf")?.tools).not.toContain("subagent");
	});

	it("raises RlmError for the arguments that the client or the tool refuses", async () => {
		cells.set("Task:\nRLM refused", [
			`from harness_rlm import RlmError
for call in (rlm.spawn("RLM text", context=3), rlm.wait("abc123", timeout=0), rlm.rename("abc123", 3)):
    try:
        await call
    except RlmError as error:
        print(error)`,
		]);
		await cli(["wait", handleOf(await cli(["spawn", "--prompt", "RLM refused"]))]);

		expect(cellResults.get("Task:\nRLM refused")).toEqual([
			"context must be text\nInvalid rlm request: /timeout must be >= 1\nInvalid rlm request: /name must be string\n",
		]);
		expect(called("Task:\nRLM text")).toBe(0);
	});

	it("serves each kernel start on its own private socket, which refuses a wrong token", async () => {
		cells.set("Task:\nRLM server", [
			'import os\nprint(os.environ["HARNESS_RLM_SOCKET"])',
			"%restart",
			'import json, os\nprint(os.environ["HARNESS_RLM_SOCKET"])\nprint(json.dumps(await rlm.list()))',
		]);
		await cli(["wait", handleOf(await cli(["spawn", "--prompt", "RLM server"]))]);
		const [first, , second] = cellResults.get("Task:\nRLM server") ?? [];
		const firstSocket = first?.trim() ?? "";
		const [secondSocket = "", listed] = second?.trim().split("\n") ?? [];
		expect(process.env.HARNESS_RLM_SOCKET).toBeUndefined();
		expect(firstSocket).toMatch(/^\/tmp\/harness-rlm-[^/]+\/kernel\.sock$/);
		// The new kernel start replaced the server of the first one.
		expect(existsSync(dirname(firstSocket))).toBe(false);
		expect(secondSocket).toMatch(/^\/tmp\/harness-rlm-[^/]+\/kernel\.sock$/);
		expect(secondSocket).not.toBe(firstSocket);
		expect(listed).toBe("[]");
		expect(statSync(dirname(secondSocket)).mode & 0o777).toBe(0o700);

		const line = JSON.stringify({ token: "wrong", action: "spawn", args: { prompts: ["RLM token"] } });
		expect(JSON.parse(await rawReply(secondSocket, line))).toEqual({ ok: false, error: "Invalid rlm token" });
		expect(called("Task:\nRLM token")).toBe(0);
		lastSocket = secondSocket;
	});

	it("marks the records of the children of a kernel, and removes the sockets when the host closes", async () => {
		await host?.close();
		expect(existsSync(dirname(lastSocket))).toBe(false);

		const store = await Harness.open(
			await openNodeSqliteStorage(join(statePaths("main").dir, "durable.sqlite")),
			{ models, registry: durable.createRegistry() },
			BACKGROUND_CONTEXT,
		);

		try {
			const state = await store.snapshot(ChildRecords, BACKGROUND_CONTEXT);
			expect(state?.children[one]?.kind).toBe("rlm");
			expect(state?.children[one]?.requests.map(({ notify }) => notify)).toEqual([false, false]);
			expect(state?.children[failing]?.caller).toBe("cli");
			expect(state?.children[failing]).not.toHaveProperty("kind");
		} finally {
			await store.close(BACKGROUND_CONTEXT);
			host = await startHost();
		}
	});
});
