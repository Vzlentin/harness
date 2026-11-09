import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Write } from "../src/children/library.ts";
import { type Client, connect } from "../src/client/client.ts";
import { type CatchUpHost, catchUp } from "../src/host/agent.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { projectDir } from "../src/protocol/projects.ts";
import type { WatchLine } from "../src/protocol/requests.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { cli, contexts, models, root, setUp, tearDown, until } from "./helpers.ts";

const PROJECT = "repo";
const execGit = promisify(execFile);

const HOOK_KIND = "fixture.catchup";

const Seen = durable.defineDoc<{ mainSha: string | null; catchups: number; hooks: Record<string, JsonValue> }>({
	kind: "harness.seen",
	version: 2,
	scope: "conversation",
	history: "latest",
	checkpointWhen: () => false,
	fork: "initial",
	initial: () => ({ mainSha: null, catchups: 0, hooks: {} }),
});

let host: Host | undefined;
let repo: string;

/**
 * What the hook of the entry gives: `{ lines, data, seen }`, where a `seen` of `"<undefined>"` gives `undefined`, which
 * is not JSON. Without it, the hook gives no lines and keeps `seen`.
 */
let hookFile: string;

/** Each `seen` that the hook got, as a JSON array. */
let hookCalls: string;

async function git(...args: string[]): Promise<string> {
	return (await execGit("git", args, { cwd: repo })).stdout.trim();
}

function openHost(): Promise<Host | undefined> {
	return runHost({ project: PROJECT, cwd: projectDir(PROJECT), models });
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
		const first = await watching.watch({ kind: "agent" });
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

async function openStore(): Promise<Harness> {
	return Harness.open(
		await openNodeSqliteStorage(join(statePaths(PROJECT).dir, "durable.sqlite")),
		{ models, registry: durable.createRegistry() },
		BACKGROUND_CONTEXT,
	);
}

/** The data of each catch-up entry of the project agent in `store`. */
async function catchUpData(store: Harness): Promise<unknown[]> {
	const page = await store.commit(
		(tx) => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 1000),
		BACKGROUND_CONTEXT,
	);

	return page.items.filter((entry) => entry.kind === "harness.catchup").map((entry) => entry.data);
}

/**
 * Runs `use` with the store of the project, with the host closed, and a catch-up host on it whose warnings go to
 * `warnings`.
 */
async function withStore(
	use: (store: Harness, agent: CatchUpHost, warnings: string[]) => Promise<void>,
): Promise<void> {
	await host?.close();
	host = undefined;
	const store = await openStore();
	const warnings: string[] = [];

	try {
		const root = await store.root(BACKGROUND_CONTEXT);
		const warn = (cause: unknown) => warnings.push(String(cause));
		await use(store, { harness: store, root, cwd: repo, catchUps: [], warn }, warnings);
	} finally {
		await store.close(BACKGROUND_CONTEXT);
	}
}

/** Writes an entry into the project agent's conversation, as the host does. */
function writer(agent: CatchUpHost): (write: Write) => Promise<void> {
	return async (write) => {
		await agent.root.submit(write, BACKGROUND_CONTEXT);
	};
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
	hookFile = join(root, "catchup.json");
	hookCalls = join(root, "catchup-calls.json");
	const module = join(root, "catchup-entry.mjs");

	await writeFile(
		module,
		`import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
export default function catchUpEntry() {
	const run = async (_harness, seen) => {
		const calls = existsSync(${JSON.stringify(hookCalls)}) ? JSON.parse(await readFile(${JSON.stringify(hookCalls)}, "utf8")) : [];
		await writeFile(${JSON.stringify(hookCalls)}, JSON.stringify([...calls, seen ?? null]));
		if (!existsSync(${JSON.stringify(hookFile)})) return { seen: seen ?? null, lines: [] };
		const part = JSON.parse(await readFile(${JSON.stringify(hookFile)}, "utf8"));
		return part.seen === "<undefined>" ? { ...part, seen: undefined } : part;
	};
	return { extensions: [], catchUp: { kind: ${JSON.stringify(HOOK_KIND)}, run }, close: async () => {} };
}
`,
	);
	setEntry("catchup", module);
	expect((await cli(["create", PROJECT, "--cwd", repo])).code).toBe(0);
	process.env.HARNESS_PROJECT = PROJECT;
	host = await openHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the catch-up of the project agent", { timeout: 60_000 }, () => {
	it("tells the agent once about new commits", async () => {
		await input("First");
		expect(contexts.get("First")).toEqual(["First"]);

		await git("commit", "--quiet", "--allow-empty", "-m", "Add feature");
		const feature = await git("rev-parse", "--short", "HEAD");
		const featureHead = await git("rev-parse", "HEAD");

		await input("Second");
		const second = contexts.get("Second") ?? [];
		expect(second).toEqual([
			"First",
			["Catch-up since your last input.", "New commits on trunk:", `- ${feature} Add feature`].join("\n"),
			"Second",
		]);

		await input("Third");
		const third = contexts.get("Third") ?? [];
		expect(third).toEqual([...second, "Third"]);

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
			expect(catchups).toEqual([{ commits: { branch: "trunk", commits: [{ sha: feature, subject: "Add feature" }] } }]);
			expect(await store.snapshot(Seen, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toEqual({
				mainSha: featureHead,
				catchups: 1,
				hooks: { [HOOK_KIND]: null },
			});
		} finally {
			await store.close(BACKGROUND_CONTEXT);
		}
	});

	it("writes the entry of a catch-up that stopped after its commit, and the facts that came after it", async () => {
		await withStore(async (store, agent, warnings) => {
			const before = (await catchUpData(store)).length;
			const write = writer(agent);
			const late = await git("rev-parse", "--short", "HEAD");
			let failing: { mockRestore(): void } | undefined;

			// The store fails at the first commit after the entry is written.
			await catchUp(
				agent,
				async (entry) => {
					await write(entry);
					failing = vi.spyOn(store, "commit").mockImplementationOnce(async () => {
						throw new Error("Store failed");
					});
				},
				"direct-1",
			);
			failing?.mockRestore();
			expect(warnings).toEqual(["catch-up: Store failed"]);

			await git("commit", "--quiet", "--allow-empty", "-m", "Later change");
			const later = await git("rev-parse", "--short", "HEAD");
			await catchUp(agent, write, "direct-2");

			// The write fails once: the next catch-up writes the planned entry.
			await git("commit", "--quiet", "--allow-empty", "-m", "Third change");
			const third = await git("rev-parse", "--short", "HEAD");

			await catchUp(
				agent,
				async () => {
					throw new Error("Write failed");
				},
				"direct-3",
			);
			await catchUp(agent, write, "direct-4");
			expect(warnings).toEqual(["catch-up: Store failed", "catch-up: Write failed"]);

			const commitsOf = (sha: string, subject: string) => ({
				commits: { branch: "trunk", commits: [{ sha, subject }] },
			});

			expect((await catchUpData(store)).slice(before)).toEqual([
				commitsOf(late, "Late change"),
				commitsOf(later, "Later change"),
				commitsOf(third, "Third change"),
			]);
			expect(await store.snapshot(Seen, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toEqual({
				mainSha: await git("rev-parse", "HEAD"),
				catchups: before + 3,
				hooks: { [HOOK_KIND]: null },
			});
		});
	});

	it("tells the agent when the default branch no longer contains the head that it saw", async () => {
		await withStore(async (store, agent, warnings) => {
			const before = (await catchUpData(store)).length;
			const write = writer(agent);
			const from = await git("rev-parse", "HEAD");
			await git("commit", "--quiet", "--allow-empty", "--amend", "-m", "Rewritten change");
			const head = await git("rev-parse", "HEAD");
			await catchUp(agent, write, "direct-reset-1");

			// A head that the repository does not have, as after a garbage collection.
			const gone = "0".repeat(40);

			await store.commit(async (tx) => {
				(await tx.doc(Seen, ROOT_CONVERSATION_ID)).mainSha = gone;
			}, BACKGROUND_CONTEXT);
			await catchUp(agent, write, "direct-reset-2");

			expect(warnings).toEqual([]);
			expect((await catchUpData(store)).slice(before)).toEqual([
				{ reset: { branch: "trunk", from, head } },
				{ reset: { branch: "trunk", from: gone, head } },
			]);
			expect((await store.snapshot(Seen, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.mainSha).toBe(head);
		});
	});

	it("gives each of two catch-ups at the same time its own entry", async () => {
		await withStore(async (store, agent, warnings) => {
			const write = writer(agent);
			await catchUp(agent, write, "direct-together-0");
			const before = (await catchUpData(store)).length;
			await git("commit", "--quiet", "--allow-empty", "-m", "Seen by both");
			const both = await git("rev-parse", "--short", "HEAD");

			// A clone with one more commit on the default branch: the second catch-up sees a fact that the first does not.
			const clone = join(root, "clone");
			await execGit("git", ["clone", "--quiet", repo, clone]);
			await execGit("git", ["commit", "--quiet", "--allow-empty", "-m", "Seen by the second"], { cwd: clone });
			const second = (await execGit("git", ["rev-parse", "--short", "HEAD"], { cwd: clone })).stdout.trim();
			const head = (await execGit("git", ["rev-parse", "HEAD"], { cwd: clone })).stdout.trim();

			await Promise.all([
				catchUp(agent, write, "direct-together-1"),
				catchUp({ ...agent, cwd: clone }, write, "direct-together-2"),
			]);

			expect(warnings).toEqual([]);
			expect((await catchUpData(store)).slice(before)).toEqual([
				{ commits: { branch: "trunk", commits: [{ sha: both, subject: "Seen by both" }] } },
				{ commits: { branch: "trunk", commits: [{ sha: second, subject: "Seen by the second" }] } },
			]);
			expect(await store.snapshot(Seen, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toMatchObject({
				mainSha: head,
				catchups: before + 2,
			});
		});
	});

	it("gives the catch-up hook of an entry what it saw last, and writes its lines and data", async () => {
		host = await openHost();
		await writeFile(hookFile, JSON.stringify({ seen: "s1", lines: [] }));
		await input("Hook first");
		await writeFile(hookFile, JSON.stringify({ seen: "s2", lines: ["Fixture fact"], data: { n: 1 } }));
		await input("Hook second");
		await rm(hookFile);

		const calls: unknown = JSON.parse(await readFile(hookCalls, "utf8"));
		expect(Array.isArray(calls) ? calls.at(-1) : calls).toBe("s1");
		expect(contexts.get("Hook second")?.at(-2)).toBe("Catch-up since your last input.\nFixture fact");

		await withStore(async (store) => {
			expect((await catchUpData(store)).at(-1)).toEqual({ hooks: { [HOOK_KIND]: { n: 1 } } });
			expect((await store.snapshot(Seen, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.hooks).toEqual({
				[HOOK_KIND]: "s2",
			});
		});
	});

	it("warns about a catch-up hook that gives a part that is not JSON, keeps what it saw, and still lists the commits", async () => {
		host = await openHost();
		await writeFile(hookFile, JSON.stringify({ seen: "<undefined>", lines: ["Bad fact"] }));
		await git("commit", "--quiet", "--allow-empty", "-m", "After the bad hook");
		const sha = await git("rev-parse", "--short", "HEAD");
		const stderr = vi.spyOn(process.stderr, "write");

		try {
			await input("Hook bad");
		} finally {
			await rm(hookFile);
		}

		const warnings = stderr.mock.calls.map(([text]) => String(text));
		stderr.mockRestore();
		expect(warnings).toContain(`warning: catch-up: ${HOOK_KIND}: invalid result: /seen must be null\n`);
		expect(contexts.get("Hook bad")?.at(-2)).toBe(
			["Catch-up since your last input.", "New commits on trunk:", `- ${sha} After the bad hook`].join("\n"),
		);

		await withStore(async (store) => {
			expect((await store.snapshot(Seen, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.hooks).toEqual({
				[HOOK_KIND]: "s2",
			});
		});
	});
});
