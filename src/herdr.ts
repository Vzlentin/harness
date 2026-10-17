import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveProject } from "./projects.ts";
import { AGENT_HANDLE, type ChildInfo, childLabel } from "./protocol.ts";

const HERDR_SOURCE = "custom:harness";

/**
 * The words of the command that runs the viewer of `handle`, with this Node and this package's CLI, so it does not
 * need the CLI on PATH: `harness <project>` for the project agent. Herdr wants a plain command name as the first word
 * of a resume command, so it starts with `env`.
 */
export function viewerCommand(handle: string, project: string): string[] {
	const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
	if (handle === AGENT_HANDLE) return ["env", process.execPath, cli, project];
	return ["env", process.execPath, cli, "--project", project, "attach", handle];
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
 * Opens a Herdr tab that runs the viewer of `child`, on the project of `env` and this process's cwd. It rejects when a
 * `herdr` call fails or gives no pane ID.
 */
export async function openViewerTab(child: ChildInfo, env: NodeJS.ProcessEnv): Promise<void> {
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
	let pane: unknown;
	try {
		pane = (JSON.parse(created) as { result?: { root_pane?: { pane_id?: unknown } } }).result?.root_pane?.pane_id;
	} catch {
		pane = undefined;
	}
	if (typeof pane !== "string") throw new Error(`herdr tab create gave no pane ID: ${created.trim()}`);
	const viewer = viewerCommand(child.handle, project)
		.map((word) => `'${word.replaceAll("'", "'\\''")}'`)
		.join(" ");
	await herdr(["pane", "run", pane, viewer], env);
}

/**
 * Reports the state of the agent `label` to the Herdr pane of this process, with the viewer of `handle` on `project` as
 * the resume command. Both methods do nothing outside Herdr.
 * The calls run one after another, so `--seq` reaches Herdr in order.
 */
export function agentReporter(
	env: NodeJS.ProcessEnv,
	label: string,
	handle: string,
	project: string,
): { report(busy: boolean): void; release(): Promise<void> } {
	const pane = env.HERDR_ENV ? env.HERDR_PANE_ID : undefined;
	const resume = pane === undefined ? [] : ["--", ...viewerCommand(handle, project)];
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
