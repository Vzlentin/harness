import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { setUp, spawnAs, startHost, tearDown } from "./helpers.ts";

/** One byte more than 1 MiB of UTF-8. */
const LARGE = "x".repeat(1024 * 1024 + 1);

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the children of a caller", { timeout: 30_000 }, () => {
	it("spawns more than 16 live children of a caller", async () => {
		const prompts = Array.from({ length: 34 }, (_, index) => `Task:\nLive ${index}`);
		const spawns = await Promise.allSettled(prompts.map((prompt) => spawnAs("live", prompt, { notify: false })));

		const refused = spawns.flatMap((spawn) => (spawn.status === "rejected" ? [String(spawn.reason)] : []));
		expect(refused).toEqual([]);

		// A repeat of a spawn is the same child, not a new one.
		const [first] = spawns;

		if (first?.status !== "fulfilled") throw new Error("no first spawn");
		const repeated = await spawnAs("live", prompts[0] ?? "", { notify: false });
		expect(repeated.handle).toBe(first.value.handle);
	});

	it("takes a spawn and a send of more than 1 MiB", async () => {
		const child = await spawnAs("large", LARGE, { notify: false });

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
});
