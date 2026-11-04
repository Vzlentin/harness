#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isThinkingLevel } from "./children/model.ts";
import { request } from "./client/client.ts";
import { piEnv } from "./client/herdr.ts";
import { type MirrorTarget, piArgs } from "./client/mirror.ts";
import {
	addProject,
	type CommandName,
	checkProject,
	MAIN_PROJECT,
	projectDir,
	readProjects,
	resolveProject,
} from "./protocol/projects.ts";
import { errorMessage } from "./protocol/requests.ts";
import { parseTarget, type Target, targetRef } from "./protocol/target.ts";
import { runTool, sendToHost, type ToolArgs } from "./tool.ts";

function fail(message: string): never {
	throw new Error(message);
}

/** A command of the CLI: its lines in the usage, and what it runs. `project` is the `--project` value. */
type Command = {
	readonly usage: readonly string[];
	run(args: string[], project: string | undefined): Promise<void> | void;
};

function usage(): never {
	const lines = [...COMMANDS.values()].flatMap((command) => command.usage);

	fail(`Usage:
  harness <project>
${lines.join("\n")}
Any command but harness <project> takes --project <name> before it; without it, the project is HARNESS_PROJECT, then the cwd.`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];

	if (!value || value.startsWith("--")) fail(`${option} requires a value`);

	return value;
}

function thinkingLevel(value: string): ModelThinkingLevel {
	if (!isThinkingLevel(value)) fail(`Invalid thinking level: ${value}`);

	return value;
}

function spawnArgs(args: string[]): ToolArgs {
	const spawn: ToolArgs = { action: "spawn" };
	const prompts: string[] = [];
	const files: string[] = [];

	for (let i = 0; i < args.length; i += 2) {
		const option = args[i];

		switch (option) {
			case "--name":
				spawn.name = valueAfter(args, i, option);
				break;
			case "--provider":
				spawn.provider = valueAfter(args, i, option);
				break;
			case "--model":
				spawn.model = valueAfter(args, i, option);
				break;
			case "--thinking":
				spawn.thinking = thinkingLevel(valueAfter(args, i, option));
				break;
			case "--cwd":
				spawn.cwd = valueAfter(args, i, option);
				break;
			case "--tools":
				spawn.tools = valueAfter(args, i, option).split(",");
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, option));
				break;
			case "--file":
				files.push(valueAfter(args, i, option));
				break;
			default:
				fail(`Unknown spawn argument: ${option}`);
		}
	}

	return { ...spawn, prompts, files };
}

function sendArgs(args: string[]): ToolArgs {
	const [handle, ...rest] = args;

	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];

	for (const arg of rest) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}

	return { action: "send", handle, message: messageParts.join(" "), followUp };
}

function waitArgs(args: string[]): ToolArgs {
	const [handle, ...rest] = args;

	if (!handle) usage();

	if (rest.length === 0) return { action: "wait", handle };

	if (rest.length !== 2 || rest[0] !== "--timeout") usage();
	const timeout = Number(rest[1]);

	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");

	return { action: "wait", handle, timeout };
}

/** The arguments of `status` or `stop`: one handle. */
function handleArgs(action: "status" | "stop", args: string[]): ToolArgs {
	const [handle] = args;

	if (args.length !== 1 || handle === undefined) usage();

	return { action, handle };
}

function renameArgs(args: string[]): ToolArgs {
	const [handle, name] = args;

	if (args.length !== 2 || handle === undefined || name === undefined) usage();

	return { action: "rename", handle, name };
}

function listArgs(args: string[]): ToolArgs {
	if (args.length !== 0) usage();

	return { action: "list" };
}

/** Adds the project `name` with the real path of `dir` to `projects.json`. */
function createCommand(args: string[]): void {
	const [name, option, dir] = args;

	if (args.length !== 3 || name === undefined || option !== "--cwd" || dir === undefined) usage();

	process.stdout.write(`Created ${name} (${addProject(name, dir)})\n`);
}

function projectsCommand(args: string[]): void {
	if (args.length !== 0) usage();

	for (const [name, dir] of Object.entries(readProjects())) process.stdout.write(`${name}  ${dir}\n`);
	process.stdout.write(`${MAIN_PROJECT}\n`);
}

/**
 * Runs the host of `project` in this process with Pi's models. It exits at once when another host runs. The project
 * comes only from `--project`, not from the env: a host can start from a child's shell of another project.
 */
async function hostCommand(args: string[], project: string): Promise<void> {
	if (args.length !== 0) usage();
	const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
	const { runHost } = await import("./host/run.ts");
	const { modelRuntime } = await createAgentSessionServices({ cwd: process.cwd() });

	const host = await runHost({
		project,
		cwd: projectDir(project),
		models: modelRuntime,
	});

	if (host === undefined) {
		process.stderr.write(`Another harness host runs (pid ${process.pid} exits)\n`);
		process.exit(0);
	}

	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void host.close());
	await host.closed;
	process.exit(0);
}

/** Opens a child, or a conversation of the children library with `--conversation <id>`, in Pi in this terminal. */
async function attachCommand(args: string[]): Promise<void> {
	const [first, id] = args;
	let ref: Target;

	if (args.length === 1 && first !== undefined && first !== "--conversation") ref = parseTarget({ handle: first });
	else if (args.length === 2 && first === "--conversation" && id) ref = parseTarget({ conversation: id });
	else usage();

	await openInPi({ project: resolveProject(process.env, process.cwd()), target: ref });
}

/** Opens the agent of the project `name`, which is `main` or a project, in Pi in this terminal. */
async function agentCommand(name: string, project: string | undefined): Promise<void> {
	if (project !== undefined) fail(`harness ${name} takes no --project`);
	await openInPi({ project: name, target: { kind: "agent" } });
}

/** The `PATH` without the `node_modules/.bin` folders that npm adds: pi-coding-agent there has its own `pi`. */
function userPath(): string {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join("node_modules", ".bin")))
		.join(delimiter);
}

/**
 * Runs Pi in this terminal with a mirror session of `target` (see the Pi extension), and exits with its code. It starts
 * the host when none runs. A first watch fails before Pi starts for an unknown child, an unknown conversation and a
 * project agent without a model.
 */
async function openInPi(target: MirrorTarget): Promise<void> {
	await request({ type: "watch", ...targetRef(target.target) }, { start: true, project: target.project });

	const result = spawnSync("pi", piArgs(target), {
		stdio: "inherit",
		env: { ...piEnv(process.env), PATH: userPath() },
	});

	if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT") {
		fail("pi is not on PATH. Install Pi to open the agent");
	}

	if (result.error !== undefined) throw result.error;
	process.exitCode = result.status ?? 1;
}

function versionCommand(args: string[], project: string | undefined): void {
	if (project !== undefined || args.length !== 0) usage();

	const json: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	process.stdout.write(`${Value.Parse(Type.Object({ version: Type.String() }), json).version}\n`);
}

/**
 * A command that runs as a call of the `subagent` tool. The caller is `PI_SESSION_ID`, or `cli` outside Pi, and the
 * defaults of a spawn come from `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`.
 */
function toolCommand(lines: readonly string[], parse: (args: string[]) => ToolArgs): Command {
	return {
		usage: lines,
		async run(args, project) {
			setProject(project);

			const { text } = await runTool(parse(args), {
				caller: process.env.PI_SESSION_ID || "cli",
				callKey: randomUUID(),
				provider: process.env.PI_PROVIDER,
				model: process.env.PI_MODEL,
				thinking: process.env.PI_REASONING_LEVEL || "medium",
				cwd: process.cwd(),
				send: sendToHost,
				signal: undefined,
			});

			process.stdout.write(text);
		},
	};
}

/** Every connection resolves the project from the env, so `--project` goes there. */
function setProject(project: string | undefined): void {
	if (project !== undefined) process.env.HARNESS_PROJECT = checkProject(project);
}

/** The commands of the CLI, in the order of the usage. */
const COMMANDS: ReadonlyMap<string, Command> = new Map(
	Object.entries({
		spawn: toolCommand(
			[
				"  harness spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]",
				"    [--cwd <dir>] [--tools <names>] (--prompt <text> | --file <path>)...",
			],
			spawnArgs,
		),
		status: toolCommand(["  harness status <handle>"], (args) => handleArgs("status", args)),
		rename: toolCommand(["  harness rename <handle> <name>"], renameArgs),
		send: toolCommand(["  harness send <handle> [--follow-up] <message>"], sendArgs),
		wait: toolCommand(["  harness wait <handle> [--timeout <seconds>]"], waitArgs),
		stop: toolCommand(["  harness stop <handle>"], (args) => handleArgs("stop", args)),
		list: toolCommand(["  harness list"], listArgs),
		attach: {
			usage: ["  harness attach <handle>", "  harness attach --conversation <id>"],
			run(args, project) {
				setProject(project);

				return attachCommand(args);
			},
		},
		host: { usage: [], run: (args, project) => hostCommand(args, checkProject(project ?? MAIN_PROJECT)) },
		create: { usage: ["  harness create <name> --cwd <dir>"], run: createCommand },
		projects: { usage: ["  harness projects"], run: projectsCommand },
		"--version": { usage: ["  harness --version"], run: versionCommand },
	} satisfies Record<CommandName | "--version", Command>),
);

/**
 * Runs a command of the table, or opens the agent of a project named alone. Any other word gives the usage.
 */
async function main(): Promise<void> {
	const all = process.argv.slice(2);
	// Only before the command, so a message or a prompt can contain the word.
	let project: string | undefined;

	if (all[0] === "--project") {
		project = valueAfter(all, 0, "--project");
		all.splice(0, 2);
	}

	const [command, ...args] = all;
	const known = command === undefined ? undefined : COMMANDS.get(command);

	if (known !== undefined) return known.run(args, project);

	if (
		command !== undefined &&
		args.length === 0 &&
		(command === MAIN_PROJECT || Object.hasOwn(readProjects(), command))
	) {
		return agentCommand(command, project);
	}

	usage();
}

main().catch((cause: unknown) => {
	process.stderr.write(`${errorMessage(cause)}\n`);
	process.exitCode = 1;
});
