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

export type AgentReporter = { report(busy: boolean): void; release(): Promise<void> };

/**
 * The words of the command that opens `target` in Pi, with this Node and this package's CLI, so it does not need the
 * CLI on PATH. Herdr wants a plain command name as the first word of a resume command, so it starts with `env`.
 */
function openCommand(target: MirrorTarget): string[] {
	return ["env", process.execPath, cliPath(), ...harnessArgs(target)];
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
	// The tab must find the same host and projects as `statePaths()` in protocol.ts and `projectsPath()` in projects.ts.
	const state = env.XDG_STATE_HOME;
	const config = env.XDG_CONFIG_HOME;

	const created = await herdr(
		[
			"tab",
			"create",
			"--cwd",
			child.cwd,
			"--label",
			childLabel(child),
			"--focus",
			...(state ? ["--env", `XDG_STATE_HOME=${state}`] : []),
			...(config ? ["--env", `XDG_CONFIG_HOME=${config}`] : []),
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
	const pane = output.result.root_pane.pane_id;

	const command = openCommand({ project, handle: child.handle })
		.map((word) => `'${word.replaceAll("'", "'\\''")}'`)
		.join(" ");

	await herdr(["pane", "run", pane, command], env);
}

/**
 * Reports the state of the agent `label` to the Herdr pane of `HARNESS_HERDR_PANE`, with the command that opens
 * `target` as the resume command. Both methods do nothing without that variable, so only a Pi that the CLI
 * started in a Herdr pane reports. The calls run one after another, so `--seq` reaches Herdr in order.
 */
export function agentReporter(env: NodeJS.ProcessEnv, label: string, target: MirrorTarget): AgentReporter {
	const pane = env[PANE_VARIABLE] || undefined;
	const resume = pane === undefined ? [] : ["--", ...openCommand(target)];
	let calls: Promise<unknown> = Promise.resolve();
	let seq = 0;
	let reported: string | undefined;

	const call = (command: string, options: readonly string[], resume: readonly string[]) => {
		if (pane === undefined) return;
		seq = Math.max(Date.now(), seq + 1);
		const args = ["pane", command, "--source", HERDR_SOURCE, "--agent", label, ...options, "--seq", String(seq), pane];
		// A failed report never stops the caller.
		calls = calls.then(() => herdr([...args, ...resume], env)).catch(() => {});
	};

	return {
		report(busy) {
			const state = busy ? "working" : "idle";

			if (state === reported) return;
			reported = state;
			call("report-agent", ["--state", state], resume);
		},
		async release() {
			call("release-agent", [], []);
			await calls;
		},
	};
}
