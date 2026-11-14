import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { cellResults, cells, cli, handleOf, setUp, spawnAs, startHost, tearDown } from "./helpers.ts";

/** The entry with the `ipython` tool that follows the contract of pi-ipython. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ipython", "index.ts");

/** One byte more than 1 MiB of UTF-8. */
const LARGE = "x".repeat(1024 * 1024 + 1);

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

describe("RLM children", { timeout: 30_000 }, () => {
	it("spawns more than 16 live RLM children of a caller", async () => {
		const rlmPrompts = Array.from({ length: 17 }, (_, index) => `Task:\nRLM live ${index}`);
		const toolPrompts = Array.from({ length: 17 }, (_, index) => `Task:\nRLM live subagent ${index}`);

		const spawns = await Promise.allSettled([
			...rlmPrompts.map((prompt) => spawnAs("live", prompt, { notify: false, kind: "rlm" })),
			...toolPrompts.map((prompt) => spawnAs("live", prompt, { notify: false })),
		]);

		const refused = spawns.flatMap((spawn) => (spawn.status === "rejected" ? [String(spawn.reason)] : []));
		expect(refused).toEqual([]);

		// A repeat of a spawn is the same child, not a new one.
		const [first] = spawns;

		if (first?.status !== "fulfilled") throw new Error("no first spawn");
		const repeated = await spawnAs("live", rlmPrompts[0] ?? "", { notify: false, kind: "rlm" });
		expect(repeated.handle).toBe(first.value.handle);
	});

	it("takes an RLM spawn and an RLM send of more than 1 MiB", async () => {
		const child = await spawnAs("large", LARGE, { notify: false, kind: "rlm" });

		const send = {
			type: "send",
			requestId: "large:send",
			caller: "large",
			handle: child.handle,
			message: LARGE,
			followUp: false,
			notify: false,
		} as const;

		expect((await request(send, { start: false }))?.verb).toMatch(/^(Prompted|Steered|Queued)/);
	});

	it("gives the API and the answer cut in the docstring of rlm, and no other limit", async () => {
		cells.set("Task:\nRLM doc", ["print(rlm.__doc__)"]);
		await cli(["wait", handleOf(await cli(["spawn", "--prompt", "RLM doc"]))]);
		const doc = cellResults.get("Task:\nRLM doc")?.[0];

		expect(doc).toContain(
			"`await rlm.spawn(prompt, *, context=None, name=None, files=None, model=None, thinking=None, cwd=None)`",
		);
		expect(doc).toContain("at 256 KiB, and adds the line `[The answer was cut at 256 KiB]`");

		for (const stale of ["17th", "1 MiB", "5 minutes", "model requests at the same time"]) {
			expect(doc).not.toContain(stale);
		}
	});
});
