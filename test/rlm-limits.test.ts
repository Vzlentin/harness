import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { errorMessage } from "../src/protocol/requests.ts";
import {
	aborted,
	answerOf,
	called,
	cellResults,
	cells,
	cli,
	gates,
	handleOf,
	models,
	root,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

/** The entry with the `ipython` tool that follows the contract of pi-ipython. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ipython", "index.ts");

/** A cell that tries each size limit of `rlm`, and prints each error. */
const SIZES = `from harness_rlm import RlmError
for call in (rlm.spawn("\\u00e9" * (512 * 1024 + 1)), rlm.spawn("x" * (2 * 1024 * 1024))):
    try:
        await call
    except RlmError as error:
        print(error)
child = await rlm.spawn("\\u00e9" * (512 * 1024 - 8))
try:
    await rlm.send(child, "x" * (1024 * 1024 + 1))
except RlmError as error:
    print(error)
await rlm.stop(child)
print("stopped")`;

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	setEntry("ipython", FIXTURE);
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("limits of the RLM children", { timeout: 30_000 }, () => {
	it("refuses a 17th live RLM child of a caller, until a stop frees a place", async () => {
		await spawnAs("live", "Task:\nRLM live subagent", { notify: false });
		const prompts = Array.from({ length: 17 }, (_, index) => `Task:\nRLM live ${index}`);

		const spawns = await Promise.allSettled(
			prompts.map((prompt) => spawnAs("live", prompt, { notify: false, kind: "rlm" })),
		);

		const spawned = spawns.flatMap((spawn, index) =>
			spawn.status === "fulfilled" ? [{ prompt: prompts[index] ?? "", handle: spawn.value.handle }] : [],
		);

		const refused = spawns.flatMap((spawn) => (spawn.status === "rejected" ? [errorMessage(spawn.reason)] : []));
		expect(spawned).toHaveLength(16);
		expect(refused).toEqual(["16 RLM children are live: stop one before you spawn another"]);

		// A repeat of a spawn is the same child, not a new one.
		const [first] = spawned;
		const repeated = await spawnAs("live", first?.prompt ?? "", { notify: false, kind: "rlm" });
		expect(repeated.handle).toBe(first?.handle);

		await request({ type: "stop", caller: "live", handle: repeated.handle }, { start: false });
		expect((await spawnAs("live", "Task:\nRLM live after stop", { notify: false, kind: "rlm" })).handle).toMatch(
			/^[a-z0-9]+$/,
		);
	});

	it("refuses an RLM spawn or send of more than 1 MiB, and a kernel line of more than 1 MiB plus 64 KiB", async () => {
		cells.set("Task:\nRLM sizes", [SIZES]);
		await cli(["wait", handleOf(await cli(["spawn", "--prompt", "RLM sizes"]))]);

		expect(cellResults.get("Task:\nRLM sizes")).toEqual([
			[
				"The prompt of an RLM spawn, with its files and context, is more than 1 MiB",
				"Invalid rlm request: the line is longer than 1 MiB plus 64 KiB",
				"The message of an RLM send is more than 1 MiB",
				"stopped",
				"",
			].join("\n"),
		]);
	});

	it("gives the API and each limit in the docstring of rlm", async () => {
		cells.set("Task:\nRLM doc", ["print(rlm.__doc__)"]);
		await cli(["wait", handleOf(await cli(["spawn", "--prompt", "RLM doc"]))]);
		const doc = cellResults.get("Task:\nRLM doc")?.[0];

		expect(doc).toContain(
			"`await rlm.spawn(prompt, *, context=None, name=None, files=None, model=None, thinking=None, cwd=None)`",
		);
		expect(doc).toContain("You can have 16 children that are not stopped. A 17th spawn raises `RlmError`");
		expect(doc).toContain("at most 1 MiB of UTF-8");
		expect(doc).toContain("after 5 minutes");
		expect(doc).toContain("at 256 KiB, and adds the line `[The answer was cut at 256 KiB]`");
		expect(doc).toContain("at most 4 model requests at the same time");
	});

	it("cuts each answer of an RLM child at 256 KiB, on a character boundary", async () => {
		const prompt = `Task:\nx${"\u20ac".repeat(90_000)}`;
		const rlmChild = await spawnAs("cut", prompt, { notify: false, kind: "rlm", requestId: "cut:rlm" });
		const subagent = await spawnAs("cut", prompt, { notify: false, requestId: "cut:subagent" });

		// 17 bytes of `Answer to Task:\nx`, then whole characters of 3 bytes up to 256 KiB.
		expect(await answerOf(rlmChild.handle)).toBe(
			`Answer to Task:\nx${"\u20ac".repeat(87_375)}\n[The answer was cut at 256 KiB]`,
		);
		expect(await answerOf(subagent.handle)).toBe(`Answer to ${prompt}`);
	});

	it("runs at most 4 model requests of the RLM children of a tree at the same time", async () => {
		const first = [1, 2, 3, 4].map((index) => `Task:\nRLM pool ${index}`);
		const fifth = "Task:\nRLM pool 5";
		const subagent = "Task:\nRLM pool subagent";
		const otherTree = "Task:\nRLM pool other tree";
		const opened = [...first, fifth, subagent, otherTree].map((prompt) => gate(prompt));

		for (const prompt of first) await spawnAs("pool", prompt, { notify: false, kind: "rlm" });
		await until(() => first.every((prompt) => called(prompt) === 1));
		await spawnAs("pool", fifth, { notify: false, kind: "rlm" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(called(fifth)).toBe(0);

		// The children of the tool and the RLM children of another tree are not in the pool of this tree.
		await spawnAs("pool", subagent, { notify: false });
		await spawnAs("pool-2", otherTree, { notify: false, kind: "rlm" });
		await until(() => called(subagent) === 1 && called(otherTree) === 1);
		expect(called(fifth)).toBe(0);

		opened[0]?.resolve();
		await until(() => called(fifth) === 1);

		for (const open of opened) open.resolve();
	});

	it("frees the slot of an RLM child during its tool calls, so its own children run", async () => {
		const parents = [1, 2, 3, 4].map((index) => `Task:\nRLM deep ${index}`);
		const leaves = [1, 2, 3, 4].map((index) => `Task:\nRLM deep leaf ${index}`);
		const opened = leaves.map((prompt) => gate(prompt));

		for (const [index, prompt] of parents.entries()) {
			cells.set(prompt, [`print(await rlm.wait(await rlm.spawn("RLM deep leaf ${index + 1}")))`]);
		}

		const handles: string[] = [];

		for (const prompt of parents) handles.push((await spawnAs("deep", prompt, { notify: false, kind: "rlm" })).handle);
		await until(() => leaves.every((prompt) => called(prompt) === 1));

		for (const open of opened) open.resolve();

		expect(await Promise.all(handles.map((handle) => answerOf(handle)))).toEqual(
			leaves.map((prompt) => `Tool said: Answer to ${prompt}`),
		);
	});

	it("aborts a turn of an RLM child after its deadline, and keeps the child", async () => {
		const dir = realpathSync(await mkdtemp(join(root, "deadline-")));
		expect((await cli(["create", "deadline", "--cwd", dir])).code).toBe(0);
		const deadline = await runHost({ project: "deadline", cwd: dir, models, rlmDeadlineMs: 1000 });

		if (deadline === undefined) throw new Error("no host");
		const project = "deadline";
		const subagentPrompt = "Task:\nRLM deadline subagent";
		const rlmPrompt = "Task:\nRLM deadline";
		const subagentGate = gate(subagentPrompt);
		gate(rlmPrompt);

		try {
			const subagent = await spawnAs("deadline", subagentPrompt, { notify: false, project });
			const rlmChild = await spawnAs("deadline", rlmPrompt, { notify: false, kind: "rlm", project });
			await expect(answerOf(rlmChild.handle, project)).rejects.toThrow(`${rlmChild.handle} was aborted`);
			expect(aborted.has(rlmPrompt)).toBe(true);

			const send = {
				type: "send",
				requestId: "deadline:send",
				caller: "deadline",
				handle: rlmChild.handle,
				message: "RLM after the deadline",
				followUp: false,
				notify: false,
			} as const;

			expect((await request(send, { start: false, project }))?.verb).toBe("Prompted");
			expect(await answerOf(rlmChild.handle, project)).toBe("Answer to RLM after the deadline");

			// Two more deadlines pass, and the child of the tool still works.
			await new Promise((resolve) => setTimeout(resolve, 2000));
			expect(aborted.has(subagentPrompt)).toBe(false);
			expect((await request({ type: "status", handle: subagent.handle }, { start: false, project }))?.state).toBe(
				"busy",
			);
			subagentGate.resolve();
			expect(await answerOf(subagent.handle, project)).toBe(`Answer to ${subagentPrompt}`);
		} finally {
			await deadline.close();
		}
	});
});

/** Holds the model requests of `prompt` until the test opens the gate. */
function gate(prompt: string): PromiseWithResolvers<void> {
	const opened = Promise.withResolvers<void>();
	gates.set(prompt, opened);

	return opened;
}
