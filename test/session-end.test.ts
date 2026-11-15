import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { MAIN_PROJECT } from "../src/protocol/projects.ts";
import {
	aborted,
	called,
	calls,
	gates,
	listenAnswers,
	setUp,
	spawnAs,
	spawnedBy,
	startHost,
	stateOf,
	tearDown,
	until,
	untilState,
} from "./helpers.ts";

/** The delay of a session end in these tests. */
const END_MS = 1000;

/** The options of an `answers` listener that comes back fast, within `END_MS`. */
const FAST_RETRIES = { start: false, retryDelaysMs: [50] };

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost(MAIN_PROJECT, { sessionEndMs: END_MS });
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("session end", { timeout: 30_000 }, () => {
	it("ends the busy children and grandchildren of a session, and the parent stays ended", async () => {
		const caller = "tree-end-session";
		gates.set("Task:\nTree leaf", Promise.withResolvers());
		const answers = listenAnswers(caller, FAST_RETRIES);
		const tree = (await spawnAs(caller, "Task:\nTree", { notify: true })).handle;
		await until(() => called("Task:\nTree leaf") === 1);
		await until(() => spawnedBy.has("Task:\nTree branch"));
		const branch = spawnedBy.get("Task:\nTree") ?? "";
		const leaf = spawnedBy.get("Task:\nTree branch") ?? "";
		answers.listener.close();

		for (const handle of [tree, branch, leaf]) await untilState(handle, "ended");
		expect(aborted.has("Task:\nTree leaf")).toBe(true);
		await sleep(500);
		expect(await stateOf(tree)).toBe("ended");
		expect(calls.some((call) => [branch, leaf].some((h) => call.prompt.startsWith(`subagent nested (${h})`)))).toBe(
			false,
		);
	});

	it("keeps the children over a reload, when the listener comes back in time", async () => {
		const caller = "reload-session";
		gates.set("Task:\nReload me", Promise.withResolvers());
		const first = listenAnswers(caller, FAST_RETRIES);
		const { handle } = await spawnAs(caller, "Task:\nReload me", { notify: true });
		await until(() => called("Task:\nReload me") === 1);
		first.listener.close();
		const second = listenAnswers(caller, FAST_RETRIES);

		try {
			await sleep(END_MS * 2);
			expect(await stateOf(handle)).toBe("busy");
			gates.get("Task:\nReload me")?.resolve();
			await until(() => second.deliveries.length === 1);
			expect(second.deliveries[0]).toMatchObject({ source: "child", handle, failed: false });
		} finally {
			second.listener.close();
		}
	});

	it("gives the waiting answers and the aborted turns on resume, and runs no child again", async () => {
		const caller = "resume-end-session";
		gates.set("Task:\nResume busy", Promise.withResolvers());
		const first = listenAnswers(caller, FAST_RETRIES);
		const busy = (await spawnAs(caller, "Task:\nResume busy", { notify: true })).handle;
		await until(() => called("Task:\nResume busy") === 1);
		first.listener.close();
		const done = (await spawnAs(caller, "Task:\nResume done", { notify: true })).handle;
		await untilState(done, "idle");

		for (const handle of [busy, done]) await untilState(handle, "ended");
		const resumed = listenAnswers(caller, FAST_RETRIES);

		try {
			await until(() => resumed.deliveries.length === 2);
			expect(resumed.deliveries).toEqual(
				expect.arrayContaining([
					{ source: "child", handle: busy, text: `${busy} was aborted`, failed: true },
					expect.objectContaining({ source: "child", handle: done, failed: false }),
				]),
			);
			await sleep(500);
			expect(called("Task:\nResume busy")).toBe(1);
			expect(called("Task:\nResume done")).toBe(1);
			expect(await stateOf(busy)).toBe("ended");
			expect(await stateOf(done)).toBe("ended");
		} finally {
			resumed.listener.close();
		}
	});

	it("keeps the children of cli and of a caller that never listened", async () => {
		gates.set("Task:\nCli keep", Promise.withResolvers());
		gates.set("Task:\nNever keep", Promise.withResolvers());
		const cliChild = (await spawnAs("cli", "Task:\nCli keep", { notify: false })).handle;
		const never = (await spawnAs("never-session", "Task:\nNever keep", { notify: true })).handle;
		await until(() => called("Task:\nCli keep") === 1 && called("Task:\nNever keep") === 1);
		await sleep(END_MS * 2);
		expect(await stateOf(cliChild)).toBe("busy");
		expect(await stateOf(never)).toBe("busy");
		gates.get("Task:\nCli keep")?.resolve();
		gates.get("Task:\nNever keep")?.resolve();
		await untilState(cliChild, "idle");
		await untilState(never, "idle");
	});

	it("ends the children of a session whose listener does not come back after a restart", async () => {
		const caller = "restart-end-session";
		gates.set("Task:\nRestart end", Promise.withResolvers());
		const answers = listenAnswers(caller, FAST_RETRIES);
		const { handle } = await spawnAs(caller, "Task:\nRestart end", { notify: true });
		await until(() => called("Task:\nRestart end") === 1);
		await host?.close();
		answers.listener.close();
		host = await startHost(MAIN_PROJECT, { sessionEndMs: END_MS });
		await untilState(handle, "ended");
	});

	it("keeps the children of a session whose listener comes back after a restart", async () => {
		const caller = "restart-keep-session";
		gates.set("Task:\nRestart keep", Promise.withResolvers());
		const answers = listenAnswers(caller, FAST_RETRIES);

		try {
			const { handle } = await spawnAs(caller, "Task:\nRestart keep", { notify: true });
			await until(() => called("Task:\nRestart keep") === 1);
			await host?.close();
			host = await startHost(MAIN_PROJECT, { sessionEndMs: END_MS });
			await sleep(END_MS * 2);
			expect(await stateOf(handle)).toBe("busy");
			gates.get("Task:\nRestart keep")?.resolve();
			await until(() => answers.deliveries.length === 1);
			expect(answers.deliveries[0]).toMatchObject({ source: "child", handle, failed: false });
		} finally {
			answers.listener.close();
		}
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
