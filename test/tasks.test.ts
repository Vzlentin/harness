import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "../src/client.ts";
import { type Host, runHost } from "../src/host.ts";
import { MAIN_PROJECT, projectDir } from "../src/projects.ts";
import { AGENT_HANDLE, type Request, statePaths, type TaskInfo } from "../src/protocol.ts";
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

/** Sends the request `type` of the task of `key`, through the socket. */
async function taskRequest<T extends "task" | "wait-task" | "abort-task">(type: T, key: string): Promise<TaskInfo> {
	const reply = await request({ type, key } as Extract<Request, { type: T }>, { start: false });
	if (reply === undefined) throw new Error("no host");
	return reply;
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
	// First in the file, so nothing has set up the project agent before this start.
	it("sets up the project agent before a start, so a child without a model takes the agent's", async () => {
		const reply = await request(
			{
				type: "start",
				kind: KIND,
				key: "agent-model",
				input: { cwd: root, prompt: "Fixture agent", agentModel: true },
			},
			{ start: false },
		);
		expect(reply).toMatchObject({ key: "agent-model" });
		expect(await taskRequest("wait-task", "agent-model")).toMatchObject({
			outcome: { status: "completed", result: "Answer to Fixture agent" },
		});
	});

	it("starts a task once per key and waits for its outcome", async () => {
		const started = await start("one", "Fixture one");
		expect(started).toMatchObject({ key: "one", kind: KIND });
		expect(await taskRequest("wait-task", "one")).toEqual({
			key: "one",
			id: started.id,
			kind: KIND,
			status: "terminal",
			outcome: { status: "completed", result: "Answer to Fixture one" },
		});
		expect((await start("one", "Other input")).id).toBe(started.id);
		expect(called("Other input")).toBe(0);
		expect((await start("one", "Other input", "fixture.nope")).id).toBe(started.id);
		expect(await taskRequest("task", "one")).toMatchObject({ status: "terminal" });
		await expect(start("two", "Fixture two", "fixture.nope")).rejects.toThrow("Unknown task kind: fixture.nope");
		await expect(taskRequest("task", "nope")).rejects.toThrow("Unknown task: nope");
		await expect(taskRequest("wait-task", "nope")).rejects.toThrow("Unknown task: nope");
	});

	it("keeps a task running through an abort of the agent, and stops it and its child with abort-task", async () => {
		gates.set("Fixture gated", Promise.withResolvers());
		const started = await start("gated", "Fixture gated");
		await until(() => called("Fixture gated") === 1);
		await request({ type: "abort", handle: AGENT_HANDLE }, { start: false });
		const running = await taskRequest("task", "gated");
		expect(running).toMatchObject({ id: started.id, status: "running" });
		expect(aborted.has("Fixture gated")).toBe(false);
		// The wait starts while the task runs, and the abort ends it with the outcome.
		const waiting = taskRequest("wait-task", "gated");
		expect(await taskRequest("abort-task", "gated")).toMatchObject({ id: started.id });
		expect(await waiting).toEqual({ ...running, status: "terminal", outcome: { status: "aborted" } });
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
		expect(await taskRequest("wait-task", "restart")).toMatchObject({
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
