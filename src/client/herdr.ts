/**
 * Opens a child or a conversation in Pi in herdr-app: each one runs in a background hc terminal, and the `herdr.space`
 * and `herdr.tab` labels of that terminal tell herdr-app where to show it.
 */
import { execFile } from "node:child_process";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { childLabel } from "../protocol/labels.ts";
import { cliPath } from "../protocol/paths.ts";
import { resolveProject } from "../protocol/projects.ts";
import type { ChildInfo } from "../protocol/requests.ts";
import { parseTarget } from "../protocol/target.ts";
import { harnessArgs, type MirrorTarget } from "./mirror.ts";

/** The label that puts an hc terminal in a space of herdr-app. Without a tab label, herdr-app opens a new tab there. */
const SPACE_LABEL = "herdr.space";

/** The label that puts an hc terminal in a tab of herdr-app, to the right of the last pane of that tab. */
const TAB_LABEL = "herdr.tab";

/** The part of the output of `hc get --json` that has the labels of the terminal. */
const TerminalLabels = Type.Object({ labels: Type.Record(Type.String(), Type.String()) });

/**
 * Where `openConversationPane` shows a conversation: in a new tab of the space `space`, in a new tab of the space of
 * the hc terminal of this process when `space` is not given, or with `side` in a new pane to the right in the tab of
 * that terminal.
 */
export type ConversationPlace = { space?: string; side?: never } | { side: true; space?: never };

/** Whether this process runs in an hc terminal. */
export function inHerdr(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.HC_TERMINAL_ID);
}

/**
 * Runs `hc` with `args` and gives its output. When `hc` fails, it rejects with the stderr of `hc`, or with the error of
 * `execFile` when stderr is empty.
 */
export function hc(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("hc", args, { env }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolve(stdout);
		});
	});
}

/**
 * The labels `names` of the hc terminal of this process, with their values, in the order of `names`. It rejects when
 * this process is not in an hc terminal, and when that terminal does not have one of `names`, or has it empty.
 */
async function callerLabels(names: readonly string[], env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
	const id = env.HC_TERMINAL_ID;

	if (!id) throw new Error("Not in an hc terminal: HC_TERMINAL_ID is not set");
	const output = await hc(["get", "--json", id], env);

	let terminal: unknown;

	try {
		terminal = JSON.parse(output);
	} catch {
		terminal = undefined;
	}

	if (!Value.Check(TerminalLabels, terminal)) throw new Error(`hc get gave no labels: ${output.trim()}`);
	const { labels } = terminal;

	return Object.fromEntries(
		names.map((name) => {
			const value = labels[name];

			if (!value) throw new Error(`The hc terminal ${id} has no ${name} label`);

			return [name, value];
		}),
	);
}

/**
 * The hc name of the terminal of `child`: its label in lowercase, with `-` in place of each character other than
 * `a-z`, `0-9`, `-` and `_`, without the characters before the first letter or digit, and cut to 32 characters. There
 * is no name when nothing is left, or when the result has the shape of an hc terminal ID, such as `t7`: hc refuses
 * these names.
 */
function terminalName(child: ChildInfo): string | undefined {
	const name = childLabel(child)
		.toLowerCase()
		.replace(/[^a-z0-9_-]/gu, "-")
		.replace(/^[^a-z0-9]+/u, "")
		.slice(0, 32);

	return name === "" || /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/u.test(name) ? undefined : name;
}

/**
 * The words of the command that opens `target` in Pi, with this Node and this package's CLI, so it does not need the
 * CLI on PATH. hc gives the program the environment of the hc server, so the command starts with `env` and the
 * `XDG_STATE_HOME` and `XDG_CONFIG_HOME` of `env`, when they are set.
 */
function openCommand(target: MirrorTarget, env: NodeJS.ProcessEnv): string[] {
	// The program must find the same host and projects as `statePaths()` in paths.ts and `projectsPath()` in
	// projects.ts.
	const assignments = ["XDG_STATE_HOME", "XDG_CONFIG_HOME"].flatMap((name) => {
		const value = env[name];

		return value ? [`${name}=${value}`] : [];
	});

	const prefix = assignments.length > 0 ? ["env", ...assignments] : [];

	return [...prefix, process.execPath, cliPath(), ...harnessArgs(target)];
}

/**
 * Opens `target` in Pi at `place` in herdr-app, on the project of `env` and this process's cwd, in a new background hc
 * terminal in the cwd of `child`, named after it. With `place.space`, the terminal gets that `herdr.space` label;
 * without it, the terminal gets the labels of the hc terminal of this process that `place` needs. It rejects before it
 * starts a terminal when it cannot read these labels, and it rejects when an `hc` call fails.
 */
async function openInHc(
	child: ChildInfo,
	target: MirrorTarget["target"],
	place: ConversationPlace,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const project = resolveProject(env, process.cwd());

	const labels =
		place.space !== undefined
			? { [SPACE_LABEL]: place.space }
			: await callerLabels(place.side ? [SPACE_LABEL, TAB_LABEL] : [SPACE_LABEL], env);

	const flags = Object.entries(labels).flatMap(([label, value]) => ["--label", `${label}=${value}`]);
	const name = terminalName(child);
	const named = name === undefined ? [] : ["--name", name];
	const command = openCommand({ project, target }, env);

	await hc(["run", "--bg", "--keep", "--no-parent", "--cwd", child.cwd, ...named, ...flags, "--", ...command], env);
}

/**
 * Opens `child` in Pi in a new herdr-app tab, in the space of the hc terminal of this process, on the project of `env`
 * and this process's cwd. It rejects before it starts a terminal when this process is not in an hc terminal or its
 * terminal has no `herdr.space` label, and it rejects when an `hc` call fails.
 */
export function openChildTab(child: ChildInfo, env: NodeJS.ProcessEnv): Promise<void> {
	return openInHc(child, parseTarget({ handle: child.handle }), {}, env);
}

/**
 * Opens the children library conversation `conversation` in Pi at `place` in herdr-app, on the project of `env` and
 * this process's cwd. For a conversation, `ChildInfo` gives the same ID in `handle` and in `conversation`. Without
 * `place.space`, it rejects before it starts a terminal when this process is not in an hc terminal, or when its
 * terminal does not have the labels that `place` needs. It rejects when an `hc` call fails.
 */
export function openConversationPane(
	conversation: ChildInfo,
	place: ConversationPlace,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	return openInHc(conversation, { kind: "conversation", id: conversation.handle }, place, env);
}
