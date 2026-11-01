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
	/**
	 * The catch-up entry that the commit of this state planned, until it is written. A catch-up writes it first, so a
	 * crash after the commit loses no fact.
	 */
	entry?: PlannedEntry;
};

/** The data of a catch-up entry. */
type CatchUpData = {
	runs: RunFacts[];
	lost?: LostRun[];
	commits?: { branch: string; commits: Commit[] };
	reset?: Reset;
};

type PlannedEntry = { requestId: string; text: string; data: CatchUpData };

/** A workflows run that the catch-up cannot report: its record is gone, or its input is not a workflows run input. */
type LostRun = { task: number; reason: string };

/** The default branch `branch` moved from `from` to `head`, which does not contain `from`. */
type Reset = { branch: string; from: string; head: string };

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
	sessions: Type.Array(
		Type.Object({
			run: Type.String(),
			conversation: Type.Integer(),
			task: Type.Integer(),
			label: Type.Optional(Type.String()),
		}),
	),
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

type Session = { run: string; conversation: number; key?: string; label?: string };

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

/**
 * The head of the default branch `branch`, and the commits on it since the last catch-up, newest first. With `reset`,
 * the head does not contain the last head, so there are no commits.
 */
type HeadCommits = { head: string; branch: string; commits: Commit[]; reset?: Reset };

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

/** The last catch-up of each conversation, so that the catch-ups of one conversation run one at a time. */
const lastCatchUps = new WeakMap<Conversation, Promise<void>>();

/**
 * Writes the catch-up entry of the project agent with `write`, before the input `requestId`, when a workflows run ended
 * or the default branch moved since the last one. The catch-ups of one agent run one at a time. It never throws: a
 * failure is a warning, and the input goes through.
 */
export function catchUp(host: CatchUpHost, write: WriteEntry, requestId: string): Promise<void> {
	const next = (lastCatchUps.get(host.root) ?? Promise.resolve()).then(() =>
		placeCatchUp(host, write, requestId).catch((cause: unknown) => host.warn(`catch-up: ${errorMessage(cause)}`)),
	);

	lastCatchUps.set(host.root, next);

	return next;
}

async function placeCatchUp(host: CatchUpHost, write: WriteEntry, requestId: string) {
	const { harness, root } = host;

	// A repeated input must not get an entry after its own first submission.
	if ((await harness.commit((tx) => tx.submissionByRequest(root.id, requestId), context)) !== undefined) return;
	const seen = await harness.snapshot(Seen, root.id, context);

	// The entry of an earlier catch-up that stopped after its commit. Its request ID makes a repeat add nothing.
	if (seen?.entry !== undefined) await writePlanned(host, write, seen.entry);
	const before = seen ?? NOTHING_SEEN;
	const git = await headCommits(host, before.mainSha);
	const started = await startedTaskIds(harness);
	const lastTaskId = Math.max(before.lastTaskId, ...started.map(Number));
	const runs: RunFacts[] = [];
	const lost: LostRun[] = [];
	const pending: number[] = [];

	for (const id of started) {
		const known = before.pending.includes(id);

		if (!known && id <= before.lastTaskId) continue;
		const found = await runFacts(host, id, known);

		switch (found?.kind) {
			case "pending":
				pending.push(id);
				break;
			case "lost":
				lost.push(found.lost);
				break;
			case "run":
				runs.push(found.facts);
				break;
		}
	}

	const data: CatchUpData = { runs };

	if (lost.length > 0) data.lost = lost;

	if (git !== undefined && git.commits.length > 0) data.commits = { branch: git.branch, commits: git.commits };

	if (git?.reset !== undefined) data.reset = git.reset;
	const mainSha = git === undefined ? before.mainSha : git.head;
	const next: SeenState = { mainSha, lastTaskId, pending, catchups: before.catchups };

	const fresh =
		seen !== undefined &&
		(runs.length > 0 || data.lost !== undefined || data.commits !== undefined || data.reset !== undefined);

	if (fresh) {
		next.catchups += 1;
		next.entry = { requestId: `catchup:${next.catchups}`, text: catchUpText(data), data };
	}

	if (seen !== undefined && sameSeen(seen, next)) return;

	// The new state and its entry go in one commit; the entry is written after it.
	await harness.commit(async (tx) => {
		const doc = await tx.doc(Seen, root.id);
		delete doc.entry;
		Object.assign(doc, next);
	}, context);

	if (next.entry !== undefined) await writePlanned(host, write, next.entry);
}

/** Writes the planned entry `entry`, then removes it from the `harness.seen` document. */
async function writePlanned(host: CatchUpHost, write: WriteEntry, entry: PlannedEntry): Promise<void> {
	const model = [{ role: "user", content: entry.text, timestamp: Date.now() }] as const;
	await write({ type: "write", requestId: entry.requestId, entry: { kind: ENTRY_KIND, model, data: entry.data } });

	await host.harness.commit(async (tx) => {
		const doc = await tx.doc(Seen, host.root.id);

		if (doc.entry?.requestId === entry.requestId) delete doc.entry;
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

/** What the catch-up reports of one task. */
type RunState = { kind: "run"; facts: RunFacts } | { kind: "lost"; lost: LostRun } | { kind: "pending" };

/**
 * The facts of the task `id` when it is a terminal workflows run, `pending` while it runs or cannot be read, and
 * nothing for another task. A lost run is the task of a run whose input is not a workflows run input, or of a `known`
 * run, which was pending, whose record is gone.
 */
async function runFacts(host: CatchUpHost, id: TaskId<JsonValue>, known: boolean): Promise<RunState | undefined> {
	const { harness, warn } = host;
	let record: Awaited<ReturnType<typeof harness.getTask<JsonValue>>>;

	try {
		record = await harness.getTask(id, context);
	} catch (error) {
		warn(`catch-up: task ${id}: ${errorMessage(error)}`);

		return { kind: "pending" };
	}

	if (record === undefined) {
		return known ? { kind: "lost", lost: { task: id, reason: "its task record is gone" } } : undefined;
	}

	if (record.kind !== RUN_KIND) return undefined;

	if (record.state.status !== "terminal") return { kind: "pending" };
	const { input } = record;

	if (!Value.Check(RunInput, input)) {
		return { kind: "lost", lost: { task: id, reason: "its input is not a workflows run input" } };
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

	return { kind: "run", facts };
}

/** The sessions of the root run `rootRun`, with their lineage keys and labels; nothing when they cannot be read. */
async function sessionsOf(host: CatchUpHost, rootRun: string): Promise<Session[] | undefined> {
	try {
		const doc = await host.harness.snapshot(SessionsDoc, rootRun, context);

		if (doc === undefined) return [];

		if (!Value.Check(Sessions, doc)) throw new Error("unexpected shape");
		const sessions: Session[] = [];

		for (const { run, conversation, label } of doc.sessions) {
			const lineage = await library.lineage(host.harness, String(conversation), context);
			const session: Session = { run, conversation };

			if (lineage !== undefined) session.key = lineage.key;

			if (label !== undefined) session.label = label;
			sessions.push(session);
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

		// A gone SHA, a force-push and a new default branch all leave a last head that the head does not contain.
		if ((await gitOut(host.cwd, ["merge-base", "--is-ancestor", since, head])) === undefined) {
			return { head, branch, commits: [], reset: { branch, from: since, head } };
		}

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

/** The text of the catch-up entry with `data`. */
function catchUpText({ runs, lost, commits, reset }: CatchUpData): string {
	const lines = ["Catch-up since your last input."];

	if (runs.length > 0) lines.push("Workflow runs that ended:", ...runs.map((facts) => `- ${runLine(facts)}`));

	if (lost !== undefined) {
		lines.push(
			"Workflow runs that cannot be reported:",
			...lost.map(({ task, reason }) => `- task ${task}: ${reason}`),
		);
	}

	if (commits !== undefined) {
		lines.push(
			`New commits on ${commits.branch}:`,
			...commits.commits.map(({ sha, subject }) => `- ${sha} ${subject}`),
		);
	}

	if (reset !== undefined) {
		lines.push(
			`${reset.branch} moved from ${reset.from} to ${reset.head}, which does not contain it: the new commits are not listed.`,
		);
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

/**
 * `[run <run>: <label> #<conversation>, ...]`, one group for each run. A session without a label gives
 * `<key> #<conversation>`, and without a key `#<conversation>`.
 */
function sessionsText(sessions: readonly Session[]): string {
	const byRun = Map.groupBy(sessions, (session) => session.run);

	return [...byRun]
		.map(([run, group]) => {
			const named = group.map(({ conversation, key, label }) => {
				const name = label ?? key;

				return name === undefined ? `#${conversation}` : `${name} #${conversation}`;
			});

			return `[run ${run}: ${named.join(", ")}]`;
		})
		.join(" ");
}
