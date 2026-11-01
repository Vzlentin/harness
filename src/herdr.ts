import { execFile } from "node:child_process";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { harnessArgs, type MirrorTarget } from "./mirror.ts";
import { resolveProject } from "./projects.ts";
import { type ChildInfo, childLabel, cliPath } from "./protocol.ts";

const HERDR_SOURCE = "custom:harness";

/**
 * The variable that gives the Herdr pane to the Pi that the CLI starts there, in place of `HERDR_ENV`. Without
 * `HERDR_ENV`, Herdr's own Pi integration does not report, so the pane shows the state of the mirrored agent, which the
 * extension reports, and not the state of Pi's own agent, which does not run.
 */
const PANE_VARIABLE = "HARNESS_HERDR_PANE";

/** The part of the output of `herdr tab create` that has the pane of the tab. */
const TabCreated = Type.Object({ result: Type.Object({ root_pane: Type.Object({ pane_id: Type.String() }) }) });

/** The part of the output of `herdr pane split` that has the new pane. */
const PaneSplit = Type.Object({ result: Type.Object({ pane: Type.Object({ pane_id: Type.String() }) }) });

export type AgentReporter = { report(busy: boolean): Promise<void>; release(): Promise<void> };

/**
 * The words of the command that opens `target` in Pi, with this Node and this package's CLI, so it does not need the
 * CLI on PATH. Herdr wants a plain command name as the first word of a resume command, so it starts with `env`.
 */
function openCommand(target: MirrorTarget): string[] {
	return ["env", process.execPath, cliPath(), ...harnessArgs(target)];
}

/** The `--env` flags of `herdr` that give `XDG_STATE_HOME` and `XDG_CONFIG_HOME` of `env`, when they are set. */
function envFlags(env: NodeJS.ProcessEnv): string[] {
	// The new pane must find the same host and projects as `statePaths()` in protocol.ts and `projectsPath()` in
	// projects.ts.
	const state = env.XDG_STATE_HOME;
	const config = env.XDG_CONFIG_HOME;

	return [
		...(state ? ["--env", `XDG_STATE_HOME=${state}`] : []),
		...(config ? ["--env", `XDG_CONFIG_HOME=${config}`] : []),
	];
}

/** Runs the command that opens `target` in Pi in the Herdr pane `pane`, with each word in single quotes. */
async function runOpen(pane: string, target: MirrorTarget, env: NodeJS.ProcessEnv): Promise<void> {
	const command = openCommand(target)
		.map((word) => `'${word.replaceAll("'", "'\\''")}'`)
		.join(" ");

	await herdr(["pane", "run", pane, command], env);
}

/** Whether this process runs in a Herdr pane, also as the Pi that the CLI starts there. */
export function inHerdr(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.HERDR_ENV || env[PANE_VARIABLE]);
}

/** The environment of the Pi that the CLI starts: in a Herdr pane, `HARNESS_HERDR_PANE` in place of `HERDR_ENV`. */
export function piEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { HERDR_ENV, ...rest } = env;

	return HERDR_ENV && env.HERDR_PANE_ID ? { ...rest, [PANE_VARIABLE]: env.HERDR_PANE_ID } : env;
}

/**
 * Runs `herdr` with `args` and gives its output. When `herdr` fails, it rejects with the stderr of `herdr`, or with the
 * error of `execFile` when stderr is empty.
 */
export function herdr(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("herdr", args, { env }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolve(stdout);
		});
	});
}

/**
 * Opens a Herdr tab that opens `child` in Pi, on the project of `env` and this process's cwd. It rejects when a
 * `herdr` call fails or gives no pane ID.
 */
export async function openChildTab(child: ChildInfo, env: NodeJS.ProcessEnv): Promise<void> {
	const project = resolveProject(env, process.cwd());

	const created = await herdr(
		["tab", "create", "--cwd", child.cwd, "--label", childLabel(child), "--focus", ...envFlags(env)],
		env,
	);

	let output: unknown;

	try {
		output = JSON.parse(created);
	} catch {
		output = undefined;
	}

	if (!Value.Check(TabCreated, output)) throw new Error(`herdr tab create gave no pane ID: ${created.trim()}`);

	await runOpen(output.result.root_pane.pane_id, { project, handle: child.handle }, env);
}

/**
 * Opens the children library conversation `conversation` in Pi, on the project of `env` and this process's cwd: in a
 * new pane to the right of the Herdr pane `place.pane`, or in a new tab of the Herdr workspace `place.workspace`. The
 * pane or tab gets the key of the conversation as its label. For a conversation, `ChildInfo` gives the same ID in
 * `handle` and in `conversation`. It rejects when a `herdr` call fails or gives no pane ID, and then makes no more
 * calls.
 */
export async function openConversationPane(
	conversation: ChildInfo,
	place: { pane: string; workspace?: never } | { workspace: string; pane?: never },
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const project = resolveProject(env, process.cwd());
	const target = { project, conversation: conversation.handle };
	const label = childLabel(conversation);

	if (place.pane !== undefined) {
		const split = await herdr(
			["pane", "split", place.pane, "--direction", "right", "--cwd", conversation.cwd, ...envFlags(env)],
			env,
		);

		let output: unknown;

		try {
			output = JSON.parse(split);
		} catch {
			output = undefined;
		}

		if (!Value.Check(PaneSplit, output)) throw new Error(`herdr pane split gave no pane ID: ${split.trim()}`);
		const pane = output.result.pane.pane_id;
		await herdr(["pane", "rename", pane, label], env);
		await runOpen(pane, target, env);

		return;
	}

	const created = await herdr(
		[
			"tab",
			"create",
			"--workspace",
			place.workspace,
			"--cwd",
			conversation.cwd,
			"--label",
			label,
			"--focus",
			...envFlags(env),
		],
		env,
	);

	let output: unknown;

	try {
		output = JSON.parse(created);
	} catch {
		output = undefined;
	}

	if (!Value.Check(TabCreated, output)) throw new Error(`herdr tab create gave no pane ID: ${created.trim()}`);

	await runOpen(output.result.root_pane.pane_id, target, env);
}

/**
 * Reports the state of the agent `label` to the Herdr pane of `HARNESS_HERDR_PANE`, with the command that opens
 * `target` as the resume command. Both methods do nothing without that variable, so only a Pi that the CLI
 * started in a Herdr pane reports. The calls run one after another, so `--seq` reaches Herdr in order. A report of
 * the state of the last report that waits or went through does nothing. After a failed last report, or after a
 * release, the next report goes to Herdr again. `report` gives the end of its call, which never rejects.
 */
export function agentReporter(env: NodeJS.ProcessEnv, label: string, target: MirrorTarget): AgentReporter {
	const pane = env[PANE_VARIABLE] || undefined;
	const resume = pane === undefined ? [] : ["--", ...openCommand(target)];
	let calls: Promise<void> = Promise.resolve();
	let seq = 0;
	let reported: string | undefined;

	/** Queues one `herdr` call; `onFailure` runs with its `--seq` when it fails. */
	const call = (
		command: string,
		options: readonly string[],
		resume: readonly string[],
		onFailure: (failed: number) => void,
	) => {
		if (pane === undefined) return calls;
		seq = Math.max(Date.now(), seq + 1);
		const mine = seq;
		const args = ["pane", command, "--source", HERDR_SOURCE, "--agent", label, ...options, "--seq", String(mine), pane];

		// A failed report never stops the caller.
		calls = calls.then(() =>
			herdr([...args, ...resume], env).then(
				() => {},
				() => onFailure(mine),
			),
		);

		return calls;
	};

	return {
		report(busy) {
			const state = busy ? "working" : "idle";

			if (state === reported) return calls;
			reported = state;

			// Only the failure of the last call forgets the state: a later call has its own state, or a release.
			return call("report-agent", ["--state", state], resume, (failed) => {
				if (failed === seq) reported = undefined;
			});
		},
		async release() {
			reported = undefined;
			await call("release-agent", [], [], () => {});
		},
	};
}
