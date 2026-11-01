import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, request } from "../src/client.ts";
import { entriesPath, readEntries, setEntry } from "../src/entries.ts";
import { type Host, runHost } from "../src/host.ts";
import { Mirror } from "../src/mirror.ts";
import { MAIN_PROJECT, projectDir } from "../src/projects.ts";
import { AGENT_HANDLE, childTitle, statePaths, type TaskInfo, type WatchLine } from "../src/protocol.ts";
import { inboxOf } from "../src/view-state.ts";
import {
	aborted,
	called,
	cli,
	fakePi,
	gates,
	logLines,
	models,
	root,
	setUp,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

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

/** Starts the gated task of `key` with `prompt`, and gives the conversation IDs of its child and its root. */
async function startWithIds(key: string, prompt: string): Promise<{ child: string; root: string }> {
	const idFile = join(root, `${key}.ids.json`);
	await request({ type: "start", kind: KIND, key, input: { cwd: root, prompt, idFile } }, { start: false });
	await until(() => called(prompt) === 1);

	return JSON.parse(await readFile(idFile, "utf8"));
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
		await expect(start("one", "Other input", "fixture.nope")).rejects.toThrow(
			`The task one is a ${KIND} task, not fixture.nope`,
		);
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
		expect((await versioned(1))?.id).toBe(first?.id);
		// A known key refuses a version that the loaded definition does not have, as a first start does.
		await expect(versioned(2)).rejects.toThrow(
			"This host has version 1 of fixture.ask, not 2: stop the host so it starts again with the installed version",
		);
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

	it("watches a task's child by conversation and steers it only while it works", async () => {
		gates.set("Fixture watched", Promise.withResolvers());
		const ids = await startWithIds("watched", "Fixture watched");
		const { id } = await taskRequest("task", "watched");
		const client = await connect({ start: false });

		if (client === undefined) throw new Error("no host");

		try {
			const watched = await client.watch({ conversation: ids.child });
			const lines: WatchLine[] = [];

			void (async () => {
				for await (const line of watched.lines) lines.push(line);
			})();

			expect(watched.child).toMatchObject({
				handle: ids.child,
				conversation: ids.child,
				name: `fixture:${id}`,
				state: "busy",
			});

			const input = { type: "input", requestId: "steer-1", message: "Fixture steer", followUp: true } as const;
			expect(await request({ ...input, conversation: ids.child }, { start: false })).toMatchObject({
				verb: "Steered",
				child: { conversation: ids.child, state: "busy" },
			});
			await until(() => lines.length > 0);
			gates.get("Fixture watched")?.resolve();
			expect(await taskRequest("wait-task", "watched")).toMatchObject({
				status: "terminal",
				outcome: { status: "completed", result: "Answer to Fixture watched" },
			});
			await until(() => lines.some((line) => !line.stopped && line.child.state === "idle"));
			// The steer went into the gated turn, after the answer to the task's question.
			expect(called("Fixture steer")).toBe(1);
			expect(lines.some((line) => line.stopped)).toBe(false);
			await expect(
				request({ ...input, requestId: "steer-2", conversation: ids.child }, { start: false }),
			).rejects.toThrow(`fixture:${id} takes input only while it works`);
		} finally {
			client.close();
			gates.delete("Fixture watched");
		}
	});

	it("aborts a task's child by conversation, and refuses other conversation IDs", async () => {
		gates.set("Fixture aborted", Promise.withResolvers());
		const ids = await startWithIds("aborted", "Fixture aborted");
		expect(await request({ type: "abort", conversation: ids.child }, { start: false })).toMatchObject({
			conversation: ids.child,
			state: "idle",
		});
		expect(aborted.has("Fixture aborted")).toBe(true);
		expect(await taskRequest("wait-task", "aborted")).toMatchObject({ outcome: { status: "failed" } });
		gates.delete("Fixture aborted");

		for (const conversation of [ids.root, "999999", "abc"]) {
			await expect(request({ type: "watch", conversation }, { start: false })).rejects.toThrow(
				`Unknown conversation: ${conversation}`,
			);
		}

		// Both targets at once: the type refuses it, so the line goes through JSON.
		const both = JSON.parse(JSON.stringify({ type: "watch", handle: AGENT_HANDLE, conversation: ids.child }));
		await expect(request(both, { start: false })).rejects.toThrow("Unknown or invalid request: watch");

		// `configure` takes only a handle, also with an extra `conversation` key.
		const configure = JSON.parse(
			JSON.stringify({ type: "configure", handle: "nosuch", conversation: ids.child, thinking: "high" }),
		);

		await expect(request(configure, { start: false })).rejects.toThrow("Unknown subagent: nosuch");
	});

	it("mirrors a task's child by conversation: steers it while it works, aborts it, and refuses configure", async () => {
		gates.set("Fixture mirrored", Promise.withResolvers());
		const ids = await startWithIds("mirrored", "Fixture mirrored");
		const { id } = await taskRequest("task", "mirrored");
		const mirror = new Mirror({ project: MAIN_PROJECT, conversation: ids.child }, () => {}, { start: false });

		try {
			await until(() => mirror.status.kind !== "connecting");
			expect(mirror.status).toEqual({ kind: "open" });
			const child = mirror.child;

			if (child === undefined) throw new Error("no child");
			expect(child).toMatchObject({ conversation: ids.child, name: `fixture:${id}`, state: "busy" });
			expect(childTitle(child)).toBe(`fixture:${id}`);
			await mirror.send("Fixture mirror steer", false);
			await until(() => mirror.view !== undefined && inboxOf(mirror.view).items.length > 0);
			// The abort targets the conversation, and gives back the steer that the host withdraws.
			expect(await mirror.abort()).toEqual(["Fixture mirror steer"]);
			expect(aborted.has("Fixture mirrored")).toBe(true);
			expect(called("Fixture mirror steer")).toBe(0);
			await expect(mirror.send("Fixture mirror idle", false)).rejects.toThrow(
				`fixture:${id} takes input only while it works`,
			);
			// A request would fail with `Unknown subagent`, so this text shows that none went.
			await expect(mirror.configure({ thinking: "high" })).rejects.toThrow(
				"A conversation of the children library keeps its model and thinking level",
			);
		} finally {
			mirror.close();
			gates.delete("Fixture mirrored");
		}
	});

	it("opens a task's child in Pi by conversation, and refuses other conversation IDs before Pi starts", async () => {
		gates.set("Fixture attached", Promise.withResolvers());
		const ids = await startWithIds("attached", "Fixture attached");
		const pi = await fakePi();

		try {
			expect(await cli(["attach", "--conversation", ids.child], pi.env)).toMatchObject({ code: 3, stderr: "" });
			expect(logLines(pi.log)).toEqual([
				`--harness main --harness-conversation ${ids.child} HERDR_ENV= HARNESS_HERDR_PANE=`,
			]);

			for (const conversation of ["999999", ids.root]) {
				expect(await cli(["attach", "--conversation", conversation], pi.env)).toMatchObject({
					code: 1,
					stderr: `Unknown conversation: ${conversation}\n`,
				});
			}

			for (const args of [
				["attach", "--conversation"],
				["attach", "--conversation", ids.child, "extra"],
			]) {
				const usage = await cli(args, pi.env);
				expect(usage.code).toBe(1);
				expect(usage.stderr).toContain("harness attach --conversation <id>");
			}

			// The usage comes before the project check.
			const noProject = await cli(["attach"], { ...pi.env, HARNESS_PROJECT: "nosuch" });
			expect(noProject.code).toBe(1);
			expect(noProject.stderr).toContain("harness attach --conversation <id>");
			expect(noProject.stderr).not.toContain("Unknown harness project");

			expect(logLines(pi.log)).toHaveLength(1);
		} finally {
			gates.get("Fixture attached")?.resolve();
			await taskRequest("wait-task", "attached");
			gates.delete("Fixture attached");
		}
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
