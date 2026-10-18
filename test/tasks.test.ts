import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, request } from "../src/client.ts";
import { entriesPath, readEntries, setEntry } from "../src/entries.ts";
import { type Host, runHost } from "../src/host.ts";
import { MAIN_PROJECT, projectDir } from "../src/projects.ts";
import { AGENT_HANDLE, statePaths, type TaskInfo } from "../src/protocol.ts";
import { aborted, called, cli, gates, models, root, setUp, startHost, tearDown, until } from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

/** Sets the entry of the fixture that gives its task. */
function setFixtureEntry(): void {
	setEntry("fixture", join(FIXTURE, "ask.ts"));
}

const KIND = "fixture.ask";

let host: Host | undefined;

/** Starts the task of `key` with `prompt`, through the socket. */
function start(key: string, prompt: string, kind = KIND): Promise<TaskInfo> {
	return request({ type: "start", kind, key, input: { cwd: root, prompt } }, { start: false }).then((reply) => {
		if (reply === undefined) throw new Error("no host");

		return reply;
	});
}

/** Sends the request `type` of the task of `key`, through the socket. */
async function taskRequest(type: "task" | "wait-task" | "abort-task", key: string): Promise<TaskInfo> {
	const reply = await request({ type, key }, { start: false });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

beforeAll(async () => {
	await setUp();
	setFixtureEntry();
	// The fixture is also a Pi package, whose old-style entry loads in each host start.
	await writeFile(
		join(root, "agent", "settings.json"),
		JSON.stringify({ retry: { enabled: false }, packages: [FIXTURE] }),
	);
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

	it("sets an entry in entries.json once", () => {
		expect(setEntry("fixture", join(FIXTURE, "ask.ts"))).toBe(false);
		expect(readEntries()).toEqual({ fixture: join(FIXTURE, "ask.ts") });
	});

	it("starts a task once per key and waits for its outcome", async () => {
		const started = await start("one", "Fixture one");
		expect(started).toMatchObject({ key: "one", kind: KIND });
		expect(await taskRequest("wait-task", "one")).toEqual({
			key: "one",
			id: started.id,
			kind: KIND,
			version: 1,
			status: "terminal",
			outcome: { status: "completed", result: "Answer to Fixture one" },
		});
		expect((await start("one", "Other input")).id).toBe(started.id);
		expect(called("Other input")).toBe(0);
		expect((await start("one", "Other input", "fixture.nope")).id).toBe(started.id);
		expect(await taskRequest("task", "one")).toMatchObject({ status: "terminal" });
		await expect(start("two", "Fixture two", "fixture.nope")).rejects.toThrow("Unknown task kind: fixture.nope");

		const versioned = (version: number) =>
			request(
				{ type: "start", kind: KIND, key: "versioned", input: { cwd: root, prompt: "Fixture versioned" }, version },
				{ start: false },
			);

		await expect(versioned(2)).rejects.toThrow(
			"This host has version 1 of fixture.ask, not 2: stop the host so it starts again with the installed version",
		);
		await expect(taskRequest("task", "versioned")).rejects.toThrow("Unknown task: versioned");
		const first = await versioned(1);
		expect(first).toMatchObject({ key: "versioned", version: 1 });
		// A known key gives its first task, whatever version the repeat names.
		expect((await versioned(2))?.id).toBe(first?.id);
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

	it("exits on idle when the only live task is blocked, such as one of an entry that is no longer installed", async () => {
		host = await startHost();
		gates.set("Fixture blocked", Promise.withResolvers());
		await start("blocked", "Fixture blocked");
		await until(() => called("Fixture blocked") === 1);
		await host?.close();
		// The child's turn resumes in the next host; it must end, so only the blocked task is left.
		gates.delete("Fixture blocked");
		await writeFile(entriesPath(), "{}");
		const { dir } = statePaths(MAIN_PROJECT);

		const idle = await runHost({
			stateDir: dir,
			project: MAIN_PROJECT,
			cwd: projectDir(MAIN_PROJECT),
			models,
			idleExitMs: 100,
		});

		if (idle === undefined) throw new Error("no host");
		let closed = false;
		void idle.closed.then(() => {
			closed = true;
		});

		try {
			await until(() => closed);
		} finally {
			await idle.close();
			setFixtureEntry();
		}

		host = await startHost();
		expect(await taskRequest("abort-task", "blocked")).toMatchObject({ key: "blocked" });
	});

	it("loads a TypeScript entry under node_modules, where Node does not strip types", async () => {
		const dir = join(root, "node_modules", "typed-entry");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "index.ts"),
			`import type * as Durable from "@earendil-works/pi-durable";
export default function typedEntry({ durable }: { readonly durable: typeof Durable }) {
	const task = durable.defineTask<unknown, { phase: "run" }, string>({
		name: "fixture.typed",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: (_task, runtime, context) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "typed" } }), context),
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	return { extensions: [], tasks: [task], close: async () => {} };
}
`,
		);
		setEntry("typed", join(dir, "index.ts"));
		// A host process of its own, as installed: the host of the tests runs under Vite, which strips types anywhere.
		const saved = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = join(root, "typed-state");
		let pid: number | undefined;

		try {
			expect(await cli(["list"])).toMatchObject({ code: 0, stdout: "No subagents\n" });
			const client = await connect({ start: false });
			pid = client?.pid;
			client?.close();
			await start("typed", "Fixture typed", "fixture.typed");
			expect(await taskRequest("wait-task", "typed")).toMatchObject({
				outcome: { status: "completed", result: "typed" },
			});
		} finally {
			if (pid !== undefined) process.kill(pid);
			process.env.XDG_STATE_HOME = saved;
		}
	});

	it("starts a task when the project agent gets no model", async () => {
		expect((await cli(["create", "bare", "--cwd", root])).code).toBe(0);

		const bare = await runHost({
			stateDir: statePaths("bare").dir,
			project: "bare",
			cwd: root,
			models: createModels(),
		});

		if (bare === undefined) throw new Error("no host");
		const saved = process.env.HARNESS_PROJECT;
		process.env.HARNESS_PROJECT = "bare";

		try {
			expect(await start("bare", "Fixture bare")).toMatchObject({ key: "bare", kind: KIND });
			expect(await taskRequest("wait-task", "bare")).toMatchObject({ status: "terminal" });
		} finally {
			if (saved === undefined) delete process.env.HARNESS_PROJECT;
			else process.env.HARNESS_PROJECT = saved;
			await bare.close();
		}
	});
});
