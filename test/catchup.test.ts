import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, connect, request } from "../src/client.ts";
import { setEntry } from "../src/entries.ts";
import { type Host, runHost } from "../src/host.ts";
import { projectDir } from "../src/projects.ts";
import { AGENT_HANDLE, statePaths, type TaskInfo, type WatchLine } from "../src/protocol.ts";
import { cli, contexts, models, root, setUp, tearDown, until } from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");
const PROJECT = "repo";
const execGit = promisify(execFile);

const Seen = durable.defineDoc<{ mainSha: string | null; lastTaskId: number; pending: number[]; catchups: number }>({
	kind: "harness.seen",
	version: 1,
	scope: "conversation",
	history: "latest",
	checkpointWhen: () => false,
	fork: "initial",
	initial: () => ({ mainSha: null, lastTaskId: 0, pending: [], catchups: 0 }),
});

let host: Host | undefined;
let repo: string;

async function git(...args: string[]): Promise<string> {
	return (await execGit("git", args, { cwd: repo })).stdout.trim();
}

function openHost(): Promise<Host | undefined> {
	return runHost({ stateDir: statePaths(PROJECT).dir, project: PROJECT, cwd: projectDir(PROJECT), models });
}

async function client(): Promise<Client> {
	const connected = await connect({ start: false });

	if (connected === undefined) throw new Error("no host");

	return connected;
}

/** Sends `message` to the project agent and waits until its turn has ended. */
async function input(message: string): Promise<void> {
	const watching = await client();
	const connected = await client();

	try {
		const first = await watching.watch(AGENT_HANDLE);
		const events: WatchLine[] = [];

		void (async () => {
			for await (const line of first.lines) events.push(line);
		})();

		await connected.request({
			type: "input",
			requestId: `input-${message}`,
			handle: AGENT_HANDLE,
			message,
			followUp: false,
		});
		const busy = () => events.findIndex((line) => !line.stopped && line.child.state === "busy");
		await until(
			() => busy() !== -1 && events.slice(busy() + 1).some((line) => !line.stopped && line.child.state === "idle"),
		);
	} finally {
		watching.close();
		connected.close();
	}
}

async function startRun(key: string, values: Record<string, JsonValue>): Promise<TaskInfo> {
	const reply = await request(
		{ type: "start", kind: "workflows.run", key, input: { cwd: repo, ...values } },
		{ start: false },
	);

	if (reply === undefined) throw new Error("no host");

	return reply;
}

async function waitRun(key: string): Promise<TaskInfo> {
	const reply = await request({ type: "wait-task", key }, { start: false });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

beforeAll(async () => {
	await setUp();
	process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_AUTHOR_NAME = "Test";
	process.env.GIT_AUTHOR_EMAIL = "test@example.com";
	process.env.GIT_COMMITTER_NAME = "Test";
	process.env.GIT_COMMITTER_EMAIL = "test@example.com";
	await writeFile(join(root, "gitconfig"), "");
	repo = join(root, PROJECT);
	await mkdir(repo);
	await git("init", "--quiet", "--initial-branch", "trunk");
	await git("commit", "--quiet", "--allow-empty", "-m", "Start");
	await git("update-ref", "refs/remotes/origin/trunk", "HEAD");
	await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
	setEntry("run", join(FIXTURE, "run.ts"));
	expect((await cli(["create", PROJECT, "--cwd", repo])).code).toBe(0);
	process.env.HARNESS_PROJECT = PROJECT;
	host = await openHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the catch-up of the project agent", { timeout: 60_000 }, () => {
	it("tells the agent once about ended runs and new commits", async () => {
		await input("First");
		expect(contexts.get("First")).toEqual(["First"]);

		const resultA = {
			status: "finished",
			subject: "Add the parser",
			branch: "ship/parser",
			head: "abc1234",
			divergence: "none",
			lessons: ["Keep it small"],
		};

		const runA = await startRun("a", { runId: "run-a", name: "ship", result: resultA });
		const release = join(root, "release-b");

		const runB = await startRun("b", {
			runId: "run-b",
			name: "fix",
			worktree: { branch: "fix/lexer" },
			release,
			labels: ["planner", "reviewer"],
			result: { status: "finished", subject: "Fix the lexer" },
		});

		expect(await waitRun("a")).toMatchObject({ status: "terminal" });
		await git("commit", "--quiet", "--allow-empty", "-m", "Add feature");
		const feature = await git("rev-parse", "--short", "HEAD");
		const featureHead = await git("rev-parse", "HEAD");

		await input("Second");
		const second = contexts.get("Second") ?? [];
		expect(second).toHaveLength(3);
		expect(second.slice(0, 1)).toEqual(["First"]);
		expect(second[2]).toBe("Second");
		const conversationA = /wf:run-a\/planner #(\d+)/.exec(second[1] ?? "")?.[1];
		expect(conversationA).toBeDefined();
		expect(second[1]).toBe(
			[
				"Catch-up since your last input.",
				"Workflow runs that ended:",
				`- run-a (ship): finished; subject: Add the parser; branch: ship/parser @ abc1234; divergence: none; lessons: ["Keep it small"]; sessions: [run run-a: wf:run-a/planner #${conversationA}]`,
				"New commits on trunk:",
				`- ${feature} Add feature`,
			].join("\n"),
		);

		await writeFile(release, "");
		expect(await waitRun("b")).toMatchObject({ status: "terminal" });
		await input("Third");
		const third = contexts.get("Third") ?? [];
		expect(third.slice(0, 3)).toEqual(second);
		const [, planner, reviewer] = /\[run run-b: planner #(\d+), reviewer #(\d+)\]/.exec(third[3] ?? "") ?? [];
		expect(planner).toBeDefined();
		expect(reviewer).toBeDefined();
		expect(third.slice(3)).toEqual([
			[
				"Catch-up since your last input.",
				"Workflow runs that ended:",
				`- run-b (fix): finished; subject: Fix the lexer; branch: fix/lexer; sessions: [run run-b: planner #${planner}, reviewer #${reviewer}]`,
			].join("\n"),
			"Third",
		]);

		await input("Fourth");
		expect(contexts.get("Fourth")).toEqual([...third, "Fourth"]);

		// A commit after the last catch-up: a repeated input must not list it before its own first submission.
		await git("commit", "--quiet", "--allow-empty", "-m", "Late change");
		await host?.close();
		host = await openHost();
		const connected = await client();

		try {
			await connected.request({
				type: "input",
				requestId: "input-Third",
				handle: AGENT_HANDLE,
				message: "Third",
				followUp: false,
			});
		} finally {
			connected.close();
		}

		await host?.close();
		host = undefined;

		const store = await Harness.open(
			await openNodeSqliteStorage(join(statePaths(PROJECT).dir, "durable.sqlite")),
			{ models, registry: durable.createRegistry() },
			BACKGROUND_CONTEXT,
		);

		try {
			const page = await store.commit(
				(tx) => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 1000),
				BACKGROUND_CONTEXT,
			);

			const catchups = page.items.filter((entry) => entry.kind === "harness.catchup").map((entry) => entry.data);
			expect(catchups).toEqual([
				{
					runs: [
						{
							task: runA.id,
							runId: "run-a",
							workflow: "ship",
							...resultA,
							sessions: [{ run: "run-a", conversation: Number(conversationA), key: "wf:run-a/planner" }],
						},
					],
					commits: { branch: "trunk", commits: [{ sha: feature, subject: "Add feature" }] },
				},
				{
					runs: [
						{
							task: runB.id,
							runId: "run-b",
							workflow: "fix",
							status: "finished",
							subject: "Fix the lexer",
							branch: "fix/lexer",
							sessions: [
								{ run: "run-b", conversation: Number(planner), key: "wf:run-b/planner", label: "planner" },
								{ run: "run-b", conversation: Number(reviewer), key: "wf:run-b/reviewer", label: "reviewer" },
							],
						},
					],
				},
			]);
			expect(await store.snapshot(Seen, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toEqual({
				mainSha: featureHead,
				lastTaskId: runB.id,
				pending: [],
				catchups: 2,
			});
		} finally {
			await store.close(BACKGROUND_CONTEXT);
		}
	});
});
