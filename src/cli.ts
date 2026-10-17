#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { addProject, checkProject, MAIN_PROJECT, readProjects } from "./projects.ts";
import { statePaths } from "./protocol.ts";
import { runTool, sendToHost, type ToolArgs } from "./tool.ts";

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
	fail(`Usage:
  harness spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]
    [--cwd <dir>] [--tools <names>] (--prompt <text> | --file <path>)...
  harness status <handle>
  harness rename <handle> <name>
  harness send <handle> [--follow-up] <message>
  harness wait <handle> [--timeout <seconds>]
  harness stop <handle>
  harness list
  harness attach <handle>
  harness create <name> --cwd <dir>
  harness projects
Any command takes --project <name>; without it, the project is HARNESS_PROJECT, then the cwd.`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
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
				spawn.thinking = valueAfter(args, i, option);
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

/** The tool arguments of a CLI command. */
function toolArgs(command: string | undefined, args: string[]): ToolArgs {
	const [first, second] = args;
	switch (command) {
		case "spawn":
			return spawnArgs(args);
		case "send":
			return sendArgs(args);
		case "wait":
			return waitArgs(args);
		case "status":
		case "stop":
			if (args.length !== 1 || first === undefined) usage();
			return { action: command, handle: first };
		case "rename":
			if (args.length !== 2 || first === undefined || second === undefined) usage();
			return { action: command, handle: first, name: second };
		case "list":
			if (args.length !== 0) usage();
			return { action: command };
		default:
			usage();
	}
}

/** The commands, which a project cannot have as its name. */
const COMMANDS = new Set([
	"spawn",
	"status",
	"rename",
	"send",
	"wait",
	"stop",
	"list",
	"attach",
	"host",
	"create",
	"projects",
]);

/** Adds the project `name` with the real path of `dir` to `projects.json`. */
function createCommand(args: string[]): void {
	const [name, option, dir] = args;
	if (args.length !== 3 || name === undefined || option !== "--cwd" || dir === undefined) usage();
	if (COMMANDS.has(name)) fail(`A project cannot have the name ${name}`);
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
	const { runHost } = await import("./host.ts");
	const { modelRuntime } = await createAgentSessionServices({ cwd: process.cwd() });
	const host = await runHost({ stateDir: statePaths(project).dir, project, models: modelRuntime });
	if (host === undefined) {
		process.stderr.write(`Another harness host runs (pid ${process.pid} exits)\n`);
		process.exit(0);
	}
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void host.close());
	await host.closed;
	process.exit(0);
}

/** Opens the viewer of a child in this terminal. */
async function attachCommand(args: string[]): Promise<void> {
	const [handle] = args;
	if (args.length !== 1 || handle === undefined) usage();
	const { ProcessTerminal } = await import("@earendil-works/pi-tui");
	const { attach } = await import("./viewer.ts");
	process.exitCode = await attach(handle, { terminal: new ProcessTerminal(), env: process.env });
}

/**
 * Runs a command as a call of the `subagent` tool. The caller is `PI_SESSION_ID`, or `cli` outside Pi, and the defaults
 * of a spawn come from `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`.
 */
async function main(): Promise<void> {
	const all = process.argv.slice(2);
	const at = all.indexOf("--project");
	let project: string | undefined;
	if (at !== -1) {
		project = valueAfter(all, at, "--project");
		all.splice(at, 2);
	}
	const [command, ...args] = all;
	if (command === "create") return createCommand(args);
	if (command === "projects") return projectsCommand(args);
	if (command === "host") return hostCommand(args, checkProject(project ?? MAIN_PROJECT));
	// Every connection resolves the project from the env, so --project goes there.
	if (project !== undefined) process.env.HARNESS_PROJECT = checkProject(project);
	if (command === "attach") return attachCommand(args);
	const { text } = await runTool(toolArgs(command, args), {
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
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
