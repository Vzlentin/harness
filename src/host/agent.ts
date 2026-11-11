/**
 * The project agent, which is the root conversation: its set-up at its first use, and its catch-up, before a user
 * input, one entry with the facts of the entries' catch-up hooks and the commits on the default branch since the agent
 * last saw them.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Conversation, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { resolveModel } from "../children/model.ts";
import { errorMessage, Json } from "../protocol/requests.ts";
import type { CatchUpHook, CatchUpPart } from "./entries.ts";
import type { Found } from "./targets.ts";

const context = BACKGROUND_CONTEXT;
const execGit = promisify(execFile);

/** How long a Git command of the catch-up may run. */
const GIT_TIMEOUT_MS = 10_000;

const ENTRY_KIND = "harness.catchup";

/** Between the short SHA and the subject of a commit in the `git log` output. */
const FIELD_SEPARATOR = "\u001f";

type SeenState = {
	/** The head of the default branch at the last catch-up; null without a repository or a branch. */
	mainSha: string | null;
	/** How many catch-up entries the agent got: the request ID of the next one is `catchup:<catchups + 1>`. */
	catchups: number;
	/** What each catch-up hook said the agent saw at the last catch-up, by hook kind. */
	hooks: Record<string, JsonValue>;
	/**
	 * The catch-up entry that the commit of this state planned, until it is written. A catch-up writes it first, so a
	 * crash after the commit loses no fact.
	 */
	entry?: PlannedEntry;
};

/** The data of a catch-up entry. */
type CatchUpData = {
	commits?: { branch: string; commits: Commit[] };
	reset?: Reset;
	/** The data of each catch-up hook that gave lines, by hook kind. */
	hooks?: Record<string, JsonValue>;
};

/** A planned entry. Its data is JSON, because a version 1 state kept data of another shape. */
type PlannedEntry = { requestId: string; text: string; data: JsonValue };

/** The default branch `branch` moved from `from` to `head`, which does not contain `from`. */
type Reset = { branch: string; from: string; head: string };

const NOTHING_SEEN: Readonly<SeenState> = { mainSha: null, catchups: 0, hooks: {} };

const PlannedEntryV1 = Type.Object({
	requestId: Type.String(),
	text: Type.String(),
	data: Json,
});

const SeenV1 = Type.Object({
	mainSha: Type.Union([Type.String(), Type.Null()]),
	catchups: Type.Integer(),
	entry: Type.Optional(PlannedEntryV1),
});

/**
 * What the project agent has seen. Undefined until its first input. The migration from version 1 drops its workflows
 * facts, `lastTaskId` and `pending`, and starts each catch-up hook with nothing seen.
 */
const Seen = defineDoc<SeenState>({
	kind: "harness.seen",
	version: 2,
	scope: "conversation",
	history: "latest",
	checkpointWhen: () => false,
	fork: "initial",
	initial: () => ({ ...NOTHING_SEEN, hooks: {} }),
	migrate: (value) => {
		const { mainSha, catchups, entry } = Value.Parse(SeenV1, value);

		return entry === undefined ? { mainSha, catchups, hooks: {} } : { mainSha, catchups, hooks: {}, entry };
	},
});

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
	/** The root conversation, which owns the host's children and is the project agent. */
	readonly root: Conversation;
	/** The project directory, for Git. */
	readonly cwd: string;
	/** The catch-up hooks of the entries, in load order. */
	readonly catchUps: readonly CatchUpHook[];
	readonly warn: (cause: unknown) => void;
};

/**
 * The root conversation as the agent of `project`. The first time, it gets Pi's default model when it has a login, else
 * the first model with a login, Pi's default thinking level, and the directory `cwd`. Without a model with a login, it
 * throws.
 */
export async function setUpAgent(
	root: Conversation,
	models: Models,
	settings: SettingsManager,
	project: string,
	cwd: string,
): Promise<Conversation> {
	if ((await root.agent(context)).model !== undefined) return root;
	// A default set after the host started applies.
	await settings.reload();
	const available = await models.getAvailable();
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	const model = available.find((found) => found.provider === provider && found.id === modelId) ?? available[0];

	if (model === undefined) {
		throw new Error(
			`No model for the ${project} agent: log in to a provider and set a default model in Pi (defaultProvider and defaultModel)`,
		);
	}

	const resolved = resolveModel(models, undefined, {
		provider: model.provider,
		model: model.id,
		fallbackThinking: settings.getDefaultThinkingLevel() ?? "medium",
	});

	await root.configure({ ...resolved, cwd }, context);

	return root;
}

/** The last catch-up of each conversation, so that the catch-ups of one conversation run one at a time. */
const lastCatchUps = new WeakMap<Conversation, Promise<void>>();

/**
 * Writes the catch-up entry of the project agent with `write`, before the input `requestId`, when a catch-up hook gave
 * lines or the default branch moved since the last one. The catch-ups of one agent run one at a time. It never throws: a
 * failure is a warning, and the input goes through.
 */
export function catchUp(host: CatchUpHost, write: WriteEntry, requestId: string): Promise<void> {
	const done = (lastCatchUps.get(host.root) ?? Promise.resolve())
		.then(async () => {
			const { harness, root } = host;

			// A repeated input must not get an entry after its own first submission.
			if ((await harness.commit((tx) => tx.submissionByRequest(root.id, requestId), context)) !== undefined) return;
			const seen = await harness.snapshot(Seen, root.id, context);

			// The entry of an earlier catch-up that stopped after its commit. Its request ID makes a repeat add nothing.
			if (seen?.entry !== undefined) await writePlanned(host, write, seen.entry);
			const before = seen ?? NOTHING_SEEN;
			const git = await headCommits(host, before.mainSha);
			const mainSha = git === undefined ? before.mainSha : git.head;
			const next: SeenState = { mainSha, catchups: before.catchups, hooks: { ...before.hooks } };
			const data: CatchUpData = {};
			const lines: string[] = [];

			for (const hook of host.catchUps) {
				const part = await hookPart(host, hook, before.hooks[hook.kind]);

				if (part === undefined) continue;
				next.hooks[hook.kind] = part.seen;

				if (part.lines.length === 0) continue;
				lines.push(...part.lines);

				if (part.data !== undefined) data.hooks = { ...data.hooks, [hook.kind]: part.data };
			}

			if (git !== undefined && git.commits.length > 0) data.commits = { branch: git.branch, commits: git.commits };

			if (git?.reset !== undefined) data.reset = git.reset;

			const fresh = seen !== undefined && (lines.length > 0 || data.commits !== undefined || data.reset !== undefined);

			if (fresh) {
				next.catchups += 1;
				next.entry = { requestId: `catchup:${next.catchups}`, text: catchUpText(lines, data), data };
			}

			if (seen !== undefined && sameSeen(seen, next)) return;

			// The new state and its entry go in one commit; the entry is written after it.
			await harness.commit(async (tx) => {
				const doc = await tx.doc(Seen, root.id);
				delete doc.entry;
				Object.assign(doc, next);
			}, context);

			if (next.entry !== undefined) await writePlanned(host, write, next.entry);
		})
		.catch((cause: unknown) => host.warn(`catch-up: ${errorMessage(cause)}`));

	lastCatchUps.set(host.root, done);

	return done;
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
	return a.mainSha === b.mainSha && a.catchups === b.catchups && Value.Equal(a.hooks, b.hooks);
}

/**
 * The part of the catch-up hook `hook`, which gets `seen`, what it said the agent saw at the last catch-up. A hook
 * that throws, such as for an invalid part, gives a warning and nothing, so it keeps its last `seen`.
 */
async function hookPart(
	host: CatchUpHost,
	hook: CatchUpHook,
	seen: JsonValue | undefined,
): Promise<CatchUpPart | undefined> {
	try {
		return await hook.run(host.harness, seen);
	} catch (error) {
		host.warn(`catch-up: ${hook.kind}: ${errorMessage(error)}`);

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

/**
 * The trimmed output of Git, or nothing when it exits with an error. It throws when Git does not start or runs longer
 * than 10 s.
 */
async function gitOut(cwd: string, args: readonly string[]): Promise<string | undefined> {
	try {
		// Catch-ups run one at a time, so a Git that hangs would hold every later input: it gets a timeout, and asks for no
		// login and takes no optional lock.
		const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

		return (await execGit("git", args, { cwd, env, timeout: GIT_TIMEOUT_MS })).stdout.trim();
	} catch (error) {
		// A failed exit has an integer code; a spawn failure, such as ENOENT, has a string code.
		if (Value.Check(Type.Object({ code: Type.Integer() }), error)) return undefined;
		throw error;
	}
}

/** The text of the catch-up entry with the lines of the hooks `hookLines`, then the commits of `data`. */
function catchUpText(hookLines: readonly string[], { commits, reset }: CatchUpData): string {
	const lines = ["Catch-up since your last input.", ...hookLines];

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
