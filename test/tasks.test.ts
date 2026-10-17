import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, request } from "../src/client.ts";
import { type Host, runHost } from "../src/host.ts";
import { MAIN_PROJECT, projectDir } from "../src/projects.ts";
import { AGENT_HANDLE, statePaths, type TaskInfo } from "../src/protocol.ts";
import { aborted, called, gates, models, root, setUp, startHost, tearDown, until } from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");
const KIND = "fixture.ask";

let host: Host | undefined;

// The host gives the `main` agent the test's HOME, not the user's home.
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => process.env.HOME ?? "",
}));

/** Starts the task of `key` with `prompt`, through the socket. */
function start(key: string, prompt: string, kind = KIND): Promise<TaskInfo> {
	return request({ type: "start", kind, key, input: { cwd: root, prompt } }, { start: false }).then((reply) => {
		if (reply === undefined) throw new Error("no host");
		return reply;
	});
}

/** The reply and every line of a `watch-task` of `key`, until the host ends the connection. */
async function watchTask(key: string): Promise<{ first: TaskInfo; lines: TaskInfo[] }> {
	const client = await connect({ start: false });
	if (client === undefined) throw new Error("no host");
	try {
		const watch = await client.watchTask(key);
		const lines: TaskInfo[] = [];
		for await (const line of watch.lines) lines.push(line);
		return { first: watch.task, lines };
	} finally {
		client.close();
	}
}

beforeAll(async () => {
	await setUp();
	await writeFile(
		join(root, "agent", "settings.json"),
		JSON.stringify({ retry: { enabled: false }, packages: [FIXTURE] }),
	);
	// The old-style entry of the fixture loads in each host start.
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("tasks of piDurable entries", { timeout: 30_000 }, () => {
	it("starts a task once per key and watches it to its outcome", async () => {
		const started = await start("one", "Fixture one");
		expect(started).toMatchObject({ key: "one", kind: KIND });
		const { first, lines } = await watchTask("one");
		expect(first.id).toBe(started.id);
		expect(lines.at(-1)).toMatchObject({
			key: "one",
			id: started.id,
			status: "terminal",
			outcome: { status: "completed", result: "Answer to Fixture one" },
		});
		expect((await start("one", "Other input")).id).toBe(started.id);
		expect(called("Other input")).toBe(0);
		expect((await start("one", "Other input", "fixture.nope")).id).toBe(started.id);
		expect(await request({ type: "task", key: "one" }, { start: false })).toMatchObject({ status: "terminal" });
		await expect(start("two", "Fixture two", "fixture.nope")).rejects.toThrow("Unknown task kind: fixture.nope");
		await expect(request({ type: "task", key: "nope" }, { start: false })).rejects.toThrow("Unknown task: nope");
	});

	it("keeps a task running through an abort of the agent, and stops it and its child with abort-task", async () => {
		gates.set("Fixture gated", Promise.withResolvers());
		const started = await start("gated", "Fixture gated");
		await until(() => called("Fixture gated") === 1);
		await request({ type: "abort", handle: AGENT_HANDLE }, { start: false });
		expect(await request({ type: "task", key: "gated" }, { start: false })).toMatchObject({ status: "running" });
		expect(aborted.has("Fixture gated")).toBe(false);
		const client = await connect({ start: false });
		if (client === undefined) throw new Error("no host");
		try {
			// The watch opens while the task runs, and the abort ends it with the outcome line.
			const watch = await client.watchTask("gated");
			expect(watch.task).toMatchObject({ id: started.id, status: "running" });
			await request({ type: "abort-task", key: "gated" }, { start: false });
			const lines: TaskInfo[] = [];
			for await (const line of watch.lines) lines.push(line);
			expect(lines).toEqual([{ ...watch.task, status: "terminal", outcome: { status: "aborted" } }]);
		} finally {
			client.close();
		}
		expect(aborted.has("Fixture gated")).toBe(true);
		gates.delete("Fixture gated");
	});

	it("resumes a task after a host restart", async () => {
		gates.set("Fixture restart", Promise.withResolvers());
		await start("restart", "Fixture restart");
		await until(() => called("Fixture restart") === 1);
		await host?.close();
		gates.delete("Fixture restart");
		host = await startHost();
		const { lines } = await watchTask("restart");
		expect(lines.at(-1)).toMatchObject({
			status: "terminal",
			outcome: { status: "completed", result: "Answer to Fixture restart" },
		});
	});

	it("keeps the host running while a started task is live", async () => {
		await host?.close();
		const { dir } = statePaths(MAIN_PROJECT);
		const idle = await runHost({
			stateDir: dir,
			project: MAIN_PROJECT,
			cwd: projectDir(MAIN_PROJECT),
			models,
			idleExitMs: 100,
		});
		if (idle === undefined) throw new Error("no host");
		host = idle;
		let closed = false;
		void idle.closed.then(() => {
			closed = true;
		});
		const gate = Promise.withResolvers<void>();
		gates.set("Fixture idle", gate);
		await start("idle", "Fixture idle");
		await until(() => called("Fixture idle") === 1);
		// No connection is open now; several idle checks pass while the task is live.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(closed).toBe(false);
		gate.resolve();
		await idle.closed;
		gates.delete("Fixture idle");
	});
});
