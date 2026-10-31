/**
 * The catch-up of the project agent: before a user input, one entry with the workflows runs that ended and the commits
 * on the default branch since the agent last saw them.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, defineDoc, defineDocFamily, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "./protocol.ts";
import { type Found, library } from "./targets.ts";
import { startedTaskIds } from "./tasks.ts";

const context = BACKGROUND_CONTEXT;
const execGit = promisify(execFile);

const RUN_KIND = "workflows.run";
const ENTRY_KIND = "harness.catchup";

/** Between the short SHA and the subject of a commit in the `git log` output. */
const FIELD_SEPARATOR = "\u001f";

type SeenState = {
	/** The head of the default branch at the last catch-up; null without a repository or a branch. */
	mainSha: string | null;
	/** The highest started task ID at the last catch-up. */
	lastTaskId: number;
	/** The workflows runs that were not terminal at the last catch-up, by task ID. */
	pending: number[];
	/** How many catch-up entries the agent got: the request ID of the next one is `catchup:<catchups + 1>`. */
	catchups: number;
};

const NOTHING_SEEN: Readonly<SeenState> = { mainSha: null, lastTaskId: 0, pending: [], catchups: 0 };

/** What the project agent has seen. Undefined until its first input. */
const Seen = defineDoc<SeenState>({
	kind: "harness.seen",
	version: 1,
	scope: "conversation",
	history: "latest",
	checkpointWhen: () => false,
	fork: "initial",
	initial: () => ({ ...NOTHING_SEEN, pending: [] }),
});

const Sessions = Type.Object({
	sessions: Type.Array(Type.Object({ run: Type.String(), conversation: Type.Integer(), task: Type.Integer() })),
});

/** The sessions of a workflows root run, as workflows writes them. */
const SessionsDoc = defineDocFamily<Static<typeof Sessions>, null>({
	kind: "workflows.sessions",
	version: 1,
	scope: "session",
	family: true,
	checkpointWhen: () => false,
	initial: () => ({ sessions: [] }),
});

const RunInput = Type.Object({
	name: Type.String(),
	runId: Type.String(),
	root: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.Object({ branch: Type.String() })),
});

const RunResult = Type.Object({
	status: Type.Optional(Type.String()),
	subject: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	head: Type.Optional(Type.String()),
	divergence: Type.Optional(Type.String()),
	lessons: Type.Optional(Type.Array(Type.Unknown())),
});

type Session = { run: string; conversation: number; key?: string };

/** One ended workflows run, as the entry gives it. */
type RunFacts = Omit<Static<typeof RunResult>, "status" | "lessons"> & {
	task: number;
	runId: string;
	workflow: string;
	status: string;
	lessons?: JsonValue[];
	sessions?: Session[];
};

type Commit = { sha: string; subject: string };

/** The head of the default branch `branch`, and the commits on it since the last catch-up, newest first. */
type HeadCommits = { head: string; branch: string; commits: Commit[] };

/** Writes an entry into the project agent's conversation. */
type WriteEntry = Found["write"];

/** What `catchUp` uses of the host. */
export type CatchUpHost = {
	readonly harness: Harness;
	/** The root conversation: the project agent. */
	readonly root: Conversation;
	/** The project directory, for Git. */
	readonly cwd: string;
	readonly warn: (cause: unknown) => void;
};

/**
 * Writes the catch-up entry of the project agent with `write`, before the input `requestId`, when a workflows run ended
 * or the default branch moved since the last one. It never throws: a failure is a warning, and the input goes through.
 */
export async function catchUp(host: CatchUpHost, write: WriteEntry, requestId: string) {
	try {
		await placeCatchUp(host, write, requestId);
	} catch (error) {
		host.warn(`catch-up: ${errorMessage(error)}`);
	}
}

async function placeCatchUp(host: CatchUpHost, write: WriteEntry, requestId: string) {
	const { harness, root } = host;

	// A repeated input must not get an entry after its own first submission.
	if ((await harness.commit((tx) => tx.submissionByRequest(root.id, requestId), context)) !== undefined) return;
	const seen = await harness.snapshot(Seen, root.id, context);
	const before = seen ?? NOTHING_SEEN;
	const git = await headCommits(host, before.mainSha);
	const started = await startedTaskIds(harness);
	const lastTaskId = Math.max(before.lastTaskId, ...started.map(Number));
	const runs: RunFacts[] = [];
	const pending: number[] = [];

	for (const id of started) {
		if (!before.pending.includes(id) && id <= before.lastTaskId) continue;
		const facts = await runFacts(host, id);

		if (facts === "pending") pending.push(id);
		else if (facts !== undefined) runs.push(facts);
	}

	const mainSha = git === undefined ? before.mainSha : git.head;
	const next: SeenState = { mainSha, lastTaskId, pending, catchups: before.catchups };
	const commits = git?.commits ?? [];
	const fresh = seen !== undefined && (runs.length > 0 || commits.length > 0);

	if (fresh) {
		next.catchups += 1;
		const text = catchUpText(runs, git);

		const data =
			git === undefined || git.commits.length === 0 ? { runs } : { runs, commits: { branch: git.branch, commits } };

		const model = [{ role: "user", content: text, timestamp: Date.now() }] as const;
		await write({ type: "write", requestId: `catchup:${next.catchups}`, entry: { kind: ENTRY_KIND, model, data } });
	}

	if (seen !== undefined && sameSeen(seen, next)) return;

	// A concurrent catch-up that committed first keeps its state, so no fact is counted twice.
	await harness.commit(async (tx) => {
		const doc = await tx.doc(Seen, root.id);

		if (doc.catchups !== before.catchups) return;
		Object.assign(doc, next);
	}, context);
}

function sameSeen(a: Readonly<SeenState>, b: Readonly<SeenState>): boolean {
	return (
		a.mainSha === b.mainSha &&
		a.lastTaskId === b.lastTaskId &&
		a.catchups === b.catchups &&
		a.pending.length === b.pending.length &&
		a.pending.every((id, index) => b.pending[index] === id)
	);
}

/**
 * The facts of the task `id` when it is a terminal workflows run, `pending` while it runs or cannot be read, and
 * nothing for another task.
 */
async function runFacts(host: CatchUpHost, id: TaskId<JsonValue>): Promise<RunFacts | "pending" | undefined> {
	const { harness, warn } = host;
	let record: Awaited<ReturnType<typeof harness.getTask<JsonValue>>>;

	try {
		record = await harness.getTask(id, context);
	} catch (error) {
		warn(`catch-up: task ${id}: ${errorMessage(error)}`);

		return "pending";
	}

	if (record === undefined || record.kind !== RUN_KIND) return undefined;

	if (record.state.status !== "terminal") return "pending";
	const { input } = record;

	if (!Value.Check(RunInput, input)) {
		warn(`catch-up: task ${id} has an input that is not a workflows run`);

		return undefined;
	}

	const { outcome } = record.state;
	const result = outcome.result !== undefined && Value.Check(RunResult, outcome.result) ? outcome.result : {};
	const status = outcome.status === "completed" && result.status !== undefined ? result.status : outcome.status;
	const facts: RunFacts = { task: id, runId: input.runId, workflow: input.name, status };

	if (result.subject !== undefined) facts.subject = result.subject;
	const branch = result.branch ?? input.worktree?.branch;

	if (branch !== undefined) facts.branch = branch;

	if (result.head !== undefined) facts.head = result.head;

	if (result.divergence !== undefined) facts.divergence = result.divergence;

	if (result.lessons !== undefined) {
		// SAFETY: the result is stored JSON, so each lesson is JSON.
		facts.lessons = result.lessons as JsonValue[];
	}

	const sessions = await sessionsOf(host, input.root ?? input.runId);

	if (sessions !== undefined) facts.sessions = sessions;

	return facts;
}

/** The sessions of the root run `rootRun`, with their lineage keys; nothing when they cannot be read. */
async function sessionsOf(host: CatchUpHost, rootRun: string): Promise<Session[] | undefined> {
	try {
		const doc = await host.harness.snapshot(SessionsDoc, rootRun, context);

		if (doc === undefined) return [];

		if (!Value.Check(Sessions, doc)) throw new Error("unexpected shape");
		const sessions: Session[] = [];

		for (const { run, conversation } of doc.sessions) {
			const lineage = await library.lineage(host.harness, String(conversation), context);
			sessions.push(lineage === undefined ? { run, conversation } : { run, conversation, key: lineage.key });
		}

		return sessions;
	} catch (error) {
		host.warn(`catch-up: sessions of ${rootRun}: ${errorMessage(error)}`);

		return undefined;
	}
}

/**
 * The head of the default branch, and the commits since `since` on it: none when `since` is null or the head. Nothing
 * without a repository or a default branch, or when Git fails.
 */
async function headCommits(host: CatchUpHost, since: string | null): Promise<HeadCommits | undefined> {
	try {
		const origin = await gitOut(host.cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
		const branch = origin?.replace(/^origin\//, "") || "main";
		const head = await gitOut(host.cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);

		if (head === undefined) return undefined;

		if (since === null || since === head) return { head, branch, commits: [] };

		const log = await execGit("git", ["log", `--format=%h${FIELD_SEPARATOR}%s`, `${since}..${head}`], {
			cwd: host.cwd,
		});

		const commits = log.stdout
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => {
				const [sha = "", ...subject] = line.split(FIELD_SEPARATOR);

				return { sha, subject: subject.join(FIELD_SEPARATOR) };
			});

		return { head, branch, commits };
	} catch (error) {
		host.warn(`catch-up: git: ${errorMessage(error)}`);

		return undefined;
	}
}

/** The trimmed output of Git, or nothing when it exits with an error. It throws when Git does not start. */
async function gitOut(cwd: string, args: readonly string[]): Promise<string | undefined> {
	try {
		return (await execGit("git", args, { cwd })).stdout.trim();
	} catch (error) {
		// A failed exit has an integer code; a spawn failure, such as ENOENT, has a string code.
		if (Value.Check(Type.Object({ code: Type.Integer() }), error)) return undefined;
		throw error;
	}
}

/** The text of the catch-up entry. */
function catchUpText(runs: readonly RunFacts[], git: HeadCommits | undefined): string {
	const lines = ["Catch-up since your last input."];

	if (runs.length > 0) lines.push("Workflow runs that ended:", ...runs.map((facts) => `- ${runLine(facts)}`));

	if (git !== undefined && git.commits.length > 0) {
		lines.push(`New commits on ${git.branch}:`, ...git.commits.map(({ sha, subject }) => `- ${sha} ${subject}`));
	}

	return lines.join("\n");
}

function runLine(facts: RunFacts): string {
	const parts = [`${facts.runId} (${facts.workflow}): ${facts.status}`];

	if (facts.subject !== undefined) parts.push(`subject: ${facts.subject}`);

	if (facts.branch !== undefined || facts.head !== undefined) {
		parts.push(`branch: ${[facts.branch, facts.head].filter((part) => part !== undefined).join(" @ ")}`);
	}

	if (facts.divergence !== undefined) parts.push(`divergence: ${facts.divergence}`);

	if (facts.lessons !== undefined) parts.push(`lessons: ${JSON.stringify(facts.lessons)}`);

	if (facts.sessions !== undefined && facts.sessions.length > 0)
		parts.push(`sessions: ${sessionsText(facts.sessions)}`);

	return parts.join("; ");
}

/** `[run <run>: <key> #<conversation>, ...]`, one group for each run. */
function sessionsText(sessions: readonly Session[]): string {
	const byRun = Map.groupBy(sessions, (session) => session.run);

	return [...byRun]
		.map(([run, group]) => {
			const named = group.map(({ conversation, key }) =>
				key === undefined ? `#${conversation}` : `${key} #${conversation}`,
			);

			return `[run ${run}: ${named.join(", ")}]`;
		})
		.join(" ");
}
