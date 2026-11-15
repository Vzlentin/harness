#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { request } from "./client/client.ts";
import { inHerdr, openInHerdr } from "./client/herdr.ts";
import { type MirrorTarget, piArgs } from "./client/mirror.ts";
import { pageFiles, writePage } from "./inspect/pages.ts";
import { DEFAULT_PORT, listens, pageLink, pageQuery, resolveBindHosts, startInspectServer } from "./inspect/server.ts";
import { sendRuleChange, sendRuleList } from "./project-tool.ts";
import {
	cliCaller,
	HARNESS_PROJECT,
	PI_MODEL,
	PI_PROVIDER,
	PI_REASONING_LEVEL,
	PI_SESSION_ID,
} from "./protocol/env.ts";
import { pageDir } from "./protocol/paths.ts";
import {
	ParleyAsks,
	parleyShowText,
	Rule,
	type RuleFilter,
	RuleKind,
	RuleStatus,
	type RuleUserChange,
} from "./protocol/project.ts";
import {
	addProject,
	type CommandName,
	checkProject,
	MAIN_PROJECT,
	projectDir,
	projectOf,
	readProjects,
} from "./protocol/projects.ts";
import { type ChildInfo, errorMessage, isThinkingLevel } from "./protocol/requests.ts";
import { AGENT_HANDLE, type ListRef, type ListTarget, parseTarget, type Target, targetRef } from "./protocol/target.ts";
import { answerLine, Todo, TodoState } from "./protocol/todo.ts";
import { treeLines } from "./protocol/tree.ts";
import { runQuery, runStop, runTodoTool, runTool, type TodoToolArgs, type ToolArgs, type ToolScope } from "./tool.ts";

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
Any command but harness <project> takes --project <name> before it; without it, the project is ${HARNESS_PROJECT}, then the cwd.`);
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
			case "--parley":
				spawn.serves = onlyServes(spawn, { parley: valueAfter(args, i, option) });
				break;
			case "--todo":
				spawn.serves = onlyServes(spawn, { todo: todoId(valueAfter(args, i, option)) });
				break;
			default:
				fail(`Unknown spawn argument: ${option}`);
		}
	}

	return { ...spawn, prompts, files };
}

/** `serves`, what the child of `spawn` serves, when no option gave it before. */
function onlyServes(spawn: ToolArgs, serves: NonNullable<ToolArgs["serves"]>): NonNullable<ToolArgs["serves"]> {
	if (spawn.serves !== undefined) fail("A spawn serves one thing: give --parley or --todo once");

	return serves;
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

/** The arguments of `status`: one handle. */
function handleArgs(action: "status", args: string[]): ToolArgs {
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

/**
 * A call of the todo tool from the arguments of `todo`, or the `sort` of a list, with the list of its target option.
 */
type TodoCall = {
	readonly args: Omit<TodoToolArgs, "list"> | { readonly action: "sort" };
	readonly target: ListTarget;
};

function todoArgs(args: string[]): TodoCall {
	const words: string[] = [];
	let target: ListTarget | undefined;
	let text: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";

		switch (arg) {
			case "--handle":
				target = onlyTarget(target, { handle: valueAfter(args, i, arg) });
				i++;
				break;
			case "--conversation":
				target = onlyTarget(target, { conversation: valueAfter(args, i, arg) });
				i++;
				break;
			case "--task":
				target = onlyTarget(target, { key: valueAfter(args, i, arg) });
				i++;
				break;
			case "--project-list":
				target = onlyTarget(target, { handle: AGENT_HANDLE });
				break;
			case "--text":
				if (text !== undefined) usage();
				text = valueAfter(args, i, arg);
				i++;
				break;
			default:
				if (arg.startsWith("--")) fail(`Unknown todo argument: ${arg}`);
				words.push(arg);
		}
	}

	const [action = "list", ...rest] = words;
	let call: TodoCall["args"];

	switch (action) {
		case "list":
		case "sort":
			if (rest.length !== 0 || text !== undefined) usage();
			call = { action };
			break;
		case "add":
			if (rest.length === 0 || text !== undefined) usage();
			call = { action, text: rest.join(" ") };
			break;
		case "set": {
			const [id, state] = rest;

			if (rest.length !== 2 || id === undefined || state === undefined) usage();
			call = { action, id: todoId(id), state: todoState(state) };

			if (text !== undefined) call.text = text;
			break;
		}

		default:
			usage();
	}

	return { args: call, target: target ?? {} };
}

/** `next`, the target of a todo option, when no option gave a target before. Otherwise it prints the usage. */
function onlyTarget(current: ListTarget | undefined, next: ListTarget): ListTarget {
	if (current !== undefined) usage();

	return next;
}

function todoId(value: string): number {
	const id = Number(value);

	if (!Value.Check(Todo.properties.id, id)) fail(`Invalid todo id: ${value}`);

	return id;
}

function todoState(value: string): TodoState {
	if (!Value.Check(TodoState, value)) fail(`Invalid todo state: ${value}`);

	return value;
}

/** Runs `todo` as a call of the todo tool, or `todo sort` as a `classify-todos` request, and prints its output. */
async function todoCommand(args: string[], project: string | undefined): Promise<void> {
	const call = todoArgs(args);

	if (call.args.action === "sort") return sortCommand(call.target, project);
	const { text } = await runTodoTool(call.args, cliScope(project), call.target);

	process.stdout.write(text);
}

/**
 * Prints the answers of the classifier about the open todos of the list `target`, default the list of the project: one
 * line for each todo, or `No open todos`.
 */
async function sortCommand(target: ListTarget, project: string | undefined): Promise<void> {
	const list = listRef(target);

	const classify =
		list === undefined ? ({ type: "classify-todos" } as const) : ({ type: "classify-todos", list } as const);

	const { answers } = await request(classify, { start: true, project });

	process.stdout.write(
		answers.length === 0 ? "No open todos\n" : answers.map((answer) => `${answerLine(answer)}\n`).join(""),
	);
}

/** The list of `target` as `classify-todos` takes it; nothing for `{}`. */
function listRef(target: ListTarget): ListRef | undefined {
	if (target.handle !== undefined) return { handle: target.handle };

	if (target.conversation !== undefined) return { conversation: target.conversation };

	return target.key === undefined ? undefined : { key: target.key };
}

/** Prints the line of each node of the tree of the project, or with `--json` the reply as one JSON line. */
async function treeCommand(args: string[], project: string | undefined): Promise<void> {
	const json = args.length === 1 && args[0] === "--json";

	if (args.length !== 0 && !json) usage();
	const reply = await request({ type: "tree" }, { start: true, project });

	process.stdout.write(
		json
			? `${JSON.stringify(reply)}\n`
			: treeLines(reply.nodes)
					.map((line) => `${line}\n`)
					.join(""),
	);
}

/** Prints the parley `slug` of the project as Markdown: its frame, its asks with their answers, and its contract. */
async function parleyCommand(args: string[], project: string | undefined): Promise<void> {
	const [action, slug] = args;

	if (args.length !== 2 || action !== "show" || slug === undefined) usage();
	const reply = await request({ type: "parley", action: "read", slug }, { start: true, project });

	if (!Value.Check(ParleyAsks, reply)) throw new Error("The host replied with no parley");
	process.stdout.write(parleyShowText(reply));
}

/** The options of `rule` after its action, by name, and the words that are not options. */
type RuleOptions = { readonly words: readonly string[]; readonly options: ReadonlyMap<string, string> };

const RULE_OPTIONS: ReadonlySet<string> = new Set(["--name", "--kind", "--value", "--status"]);

function ruleOptions(args: string[]): RuleOptions {
	const words: string[] = [];
	const options = new Map<string, string>();

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";

		if (!arg.startsWith("--")) {
			words.push(arg);
			continue;
		}

		if (!RULE_OPTIONS.has(arg) || options.has(arg)) fail(`Unknown rule argument: ${arg}`);
		options.set(arg, valueAfter(args, i, arg));
		i++;
	}

	return { words, options };
}

/** Prints the usage when `options` has an option that is not one of `allowed`. */
function onlyOptions(options: RuleOptions["options"], allowed: readonly string[]): void {
	if ([...options.keys()].some((option) => !allowed.includes(option))) usage();
}

function ruleId(value: string | undefined): number {
	const id = Number(value);

	if (!Value.Check(Rule.properties.id, id)) fail(`Invalid rule id: ${value}`);

	return id;
}

function ruleKind(value: string | undefined): RuleKind | undefined {
	if (value !== undefined && !Value.Check(RuleKind, value)) fail(`Invalid rule kind: ${value}`);

	return value;
}

function ruleStatus(value: string | undefined): RuleStatus | undefined {
	if (value !== undefined && !Value.Check(RuleStatus, value)) fail(`Invalid rule status: ${value}`);

	return value;
}

/**
 * The change of a rule by the user from the arguments of `rule`, or the filter of `rule list`. The action is the first
 * argument, `list` when there is none, and the options come after it.
 */
function ruleArgs(args: string[]): RuleUserChange | { readonly action: "list"; readonly filter: RuleFilter } {
	const [action = "list", ...after] = args;
	const { words: rest, options } = ruleOptions(after);

	switch (action) {
		case "list": {
			onlyOptions(options, ["--kind", "--status"]);

			if (rest.length !== 0) usage();
			const kind = ruleKind(options.get("--kind"));
			const status = ruleStatus(options.get("--status"));

			return { action, filter: { ...(kind && { kind }), ...(status && { status }) } };
		}

		case "decide":
		case "retire":
		case "delete":
			onlyOptions(options, []);

			if (rest.length !== 1) usage();

			return { action, id: ruleId(rest[0]) };
		case "edit": {
			onlyOptions(options, ["--name", "--kind", "--value"]);

			if (rest.length !== 1) usage();
			const name = options.get("--name");
			const kind = ruleKind(options.get("--kind"));
			const value = options.get("--value");

			return { action, id: ruleId(rest[0]), ...(name && { name }), ...(kind && { kind }), ...(value && { value }) };
		}

		case "create": {
			onlyOptions(options, ["--name", "--kind", "--value"]);
			const name = options.get("--name");
			const kind = ruleKind(options.get("--kind"));
			const value = options.get("--value");

			if (rest.length !== 0 || name === undefined || kind === undefined || value === undefined) usage();

			return { action, name, kind, value };
		}

		default:
			usage();
	}
}

/** Lists the rules of the project, or makes a change of a rule as the user, and prints the lines. */
async function ruleCommand(args: string[], project: string | undefined): Promise<void> {
	const call = ruleArgs(args);
	const scope = cliScope(project);

	const { text } = call.action === "list" ? await sendRuleList(call.filter, scope) : await sendRuleChange(call, scope);

	process.stdout.write(text);
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

	const { createAgentSessionServices, ExtensionRunner, ModelRegistry, SessionManager } =
		await import("@earendil-works/pi-coding-agent");

	const { runHost } = await import("./host/run.ts");
	const cwd = projectDir(project);
	const { modelRuntime, resourceLoader } = await createAgentSessionServices({ cwd });
	const { extensions, runtime } = resourceLoader.getExtensions();

	const runner = new ExtensionRunner(
		extensions,
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		new ModelRegistry(modelRuntime),
	);

	runtime.createContext = () => runner.createContext();

	const host = await runHost({
		project,
		cwd,
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

/**
 * The target of `args`, `<handle>` or `--conversation <id>`, and the words after it. A first word that starts with
 * `--` is not a handle.
 */
function commandTarget(args: string[]) {
	const [first, id, ...rest] = args;

	if (first === "--conversation" && id) return { target: parseTarget({ conversation: id }), rest };

	if (first === undefined || first.startsWith("--")) usage();

	return { target: parseTarget({ handle: first }), rest: args.slice(1) };
}

/**
 * Opens a child, or a conversation of the children library with `--conversation <id>`, in Pi in this terminal. With
 * `--side` in an hc terminal, it opens it in a new herdr-app pane to the right in the tab of that terminal, and exits.
 */
async function attachCommand(args: string[], project: string | undefined): Promise<void> {
	const { target, rest } = commandTarget(args);
	const side = rest.length === 1 && rest[0] === "--side";

	if (rest.length > 0 && !side) usage();
	const name = projectOf(project, process.env, process.cwd());
	const child = await checkTarget({ project: name, target });

	if (side && inHerdr(process.env)) {
		await openInHerdr(child, target, { side: true }, { ...process.env, [HARNESS_PROJECT]: name });
	} else {
		runPi({ project: name, target });
	}
}

/** Prints the answer of the query model to a question about a child, or a conversation with `--conversation <id>`. */
async function queryCommand(args: string[], project: string | undefined): Promise<void> {
	const { target, rest } = commandTarget(args);
	const question = rest.join(" ").trim();

	if (question === "") usage();
	const { text } = await runQuery(targetRef(target), question, cliScope(project));

	process.stdout.write(text);
}

/** Stops a child, or the child of the conversation `<id>` with `--conversation <id>`, and the children it spawned. */
async function stopCommand(args: string[], project: string | undefined): Promise<void> {
	const { target, rest } = commandTarget(args);

	if (rest.length > 0) usage();
	const { text } = await runStop(targetRef(target), cliScope(project));

	process.stdout.write(text);
}

/** Opens the agent of the project `name`, which is `main` or a project, in Pi in this terminal. */
async function agentCommand(name: string, project: string | undefined): Promise<void> {
	if (project !== undefined) fail(`harness ${name} takes no --project`);
	const target: MirrorTarget = { project: name, target: { kind: "agent" } };

	await checkTarget(target);
	runPi(target);
}

/** The `PATH` without the `node_modules/.bin` folders that npm adds: pi-coding-agent there has its own `pi`. */
function userPath(): string {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join("node_modules", ".bin")))
		.join(delimiter);
}

/**
 * Sends a first watch of `target` and gives its child. It starts the host when none runs, and fails for an unknown
 * child, an unknown conversation and a project agent without a model, before anything opens.
 */
async function checkTarget(target: MirrorTarget): Promise<ChildInfo> {
	const { project } = target;
	const { child } = await request({ type: "watch", ...targetRef(target.target) }, { start: true, project });

	return child;
}

/** Runs Pi in this terminal with a mirror session of `target` (see the Pi extension), and exits with its code. */
function runPi(target: MirrorTarget): void {
	const result = spawnSync("pi", piArgs(target), {
		stdio: "inherit",
		env: { ...process.env, PATH: userPath() },
	});

	if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT") {
		fail("pi is not on PATH. Install Pi to open the agent");
	}

	if (result.error !== undefined) throw result.error;
	process.exitCode = result.status ?? 1;
}

/** The arguments of `inspect` and `page` after their own: the target, if any, and where the server listens. */
type ServerArgs = {
	ref: Target | undefined;
	port: number | undefined;
	host: string | undefined;
	tailscale: boolean;
};

function serverArgs(command: "inspect" | "page", args: string[]): ServerArgs {
	const parsed: ServerArgs = { ref: undefined, port: undefined, host: undefined, tailscale: false };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";

		switch (arg) {
			case "--conversation":
				if (parsed.ref !== undefined) usage();
				parsed.ref = parseTarget({ conversation: valueAfter(args, i, arg) });
				i++;
				break;
			case "--port":
				parsed.port = portNumber(valueAfter(args, i, arg));
				i++;
				break;
			case "--host":
				parsed.host = valueAfter(args, i, arg);
				i++;
				break;
			case "--tailscale":
				parsed.tailscale = true;
				break;
			default:
				if (arg.startsWith("--")) fail(`Unknown ${command} argument: ${arg}`);

				if (parsed.ref !== undefined) usage();
				parsed.ref = parseTarget({ handle: arg });
		}
	}

	return parsed;
}

function portNumber(value: string): number {
	const port = Number(value);

	if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be an integer from 0 to 65535");

	return port;
}

/**
 * Serves the inspect UI until SIGINT or SIGTERM, and prints its URL on each bound address: with the target of the
 * arguments in the query, the project agent with `--project` alone, or the picker of the projects without either.
 */
async function inspectCommand(args: string[], project: string | undefined): Promise<void> {
	const { ref, port, host, tailscale } = serverArgs("inspect", args);

	const target: MirrorTarget | undefined =
		ref === undefined && project === undefined
			? undefined
			: { project: projectOf(project, process.env, process.cwd()), target: ref ?? { kind: "agent" } };

	const server = await startInspectServer({ hosts: await resolveBindHosts({ host, tailscale }), port });

	// Before the URLs: a reader can stop the command as soon as it reads the first one.
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => void server.close().then(() => process.exit(0)));
	}

	for (const url of server.urls) process.stdout.write(`${url}${target === undefined ? "" : pageQuery(target)}\n`);
}

/** The arguments of `page`: the folder and the slug of the page, then those of `serverArgs`. */
type PageArgs = ServerArgs & { folder: string; slug: string };

function pageArgs(args: string[]): PageArgs {
	const [folder, ...rest] = args;

	if (folder === undefined || folder.startsWith("--")) usage();
	const at = rest.indexOf("--slug");

	if (at === -1) usage();
	const slug = valueAfter(rest, at, "--slug");
	rest.splice(at, 2);

	return { folder, slug, ...serverArgs("page", rest) };
}

/**
 * Copies the page in `<folder>` to the pages of the inspect routes, and prints its link on each address, with the target
 * that its Send posts to: the target of the arguments, else the child or the project agent of `PI_SESSION_ID`. It starts
 * no server: a line notes an address where none listens.
 */
async function pageCommand(args: string[], project: string | undefined): Promise<void> {
	const { folder, slug, ref, port = DEFAULT_PORT, host, tailscale } = pageArgs(args);
	const dest = pageDir(slug);
	const files = pageFiles(folder);
	const name = projectOf(project, process.env, process.cwd());
	const target: MirrorTarget = { project: name, target: ref ?? (await callerTarget(name)) };
	const hosts = await resolveBindHosts({ host, tailscale });
	writePage(dest, folder, files);
	const open = await Promise.all(hosts.map((address) => listens(address, port)));

	for (const [index, address] of hosts.entries()) {
		const note = open[index] === true ? "" : "  (no server listens: harness inspect serves the pages)";
		process.stdout.write(`${pageLink(address, port, slug, target)}${note}\n`);
	}
}

/** The target of the caller of this process in the host of `project`: its child by handle, or the project agent. */
async function callerTarget(project: string): Promise<Target> {
	const caller = process.env[PI_SESSION_ID];

	if (!caller) fail("Give <handle> or --conversation <id>: PI_SESSION_ID is not set");
	const reply = await request({ type: "whoami", caller }, { start: false, project });

	if (reply === undefined) fail(`The harness host of ${project} is not running`);

	return parseTarget(reply);
}

function versionCommand(args: string[], project: string | undefined): void {
	if (project !== undefined || args.length !== 0) usage();

	const json: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	process.stdout.write(`${Value.Parse(Type.Object({ version: Type.String() }), json).version}\n`);
}

/**
 * The scope of a tool call of the CLI, to the host of `project`. The caller is `PI_SESSION_ID`, or `cli` outside Pi. The
 * host gives a spawn the `subagentModel` and `subagentThinkingLevel` of Pi's global settings, else `PI_PROVIDER`,
 * `PI_MODEL` and `PI_REASONING_LEVEL`.
 */
function cliScope(project: string | undefined): ToolScope {
	return {
		caller: cliCaller(process.env),
		callKey: randomUUID(),
		provider: process.env[PI_PROVIDER],
		model: process.env[PI_MODEL],
		thinking: process.env[PI_REASONING_LEVEL] || "medium",
		cwd: process.cwd(),
		send: (message, signal) => request(message, { start: true, signal, project }),
		signal: undefined,
	};
}

/** A command that runs as a call of the `subagent` tool. */
function toolCommand(lines: readonly string[], parse: (args: string[]) => ToolArgs): Command {
	return {
		usage: lines,
		async run(args, project) {
			const { text } = await runTool(parse(args), cliScope(project));

			process.stdout.write(text);
		},
	};
}

/** The commands of the CLI, in the order of the usage. */
const COMMANDS: ReadonlyMap<string, Command> = new Map(
	Object.entries({
		spawn: toolCommand(
			[
				"  harness spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]",
				"    [--cwd <dir>] [--tools <names>] [--parley <slug> | --todo <id>] (--prompt <text> | --file <path>)...",
			],
			spawnArgs,
		),
		status: toolCommand(["  harness status <handle>"], (args) => handleArgs("status", args)),
		rename: toolCommand(["  harness rename <handle> <name>"], renameArgs),
		send: toolCommand(["  harness send <handle> [--follow-up] <message>"], sendArgs),
		wait: toolCommand(["  harness wait <handle> [--timeout <seconds>]"], waitArgs),
		stop: { usage: ["  harness stop (<handle> | --conversation <id>)"], run: stopCommand },
		list: toolCommand(["  harness list"], listArgs),
		query: { usage: ["  harness query (<handle> | --conversation <id>) <question>"], run: queryCommand },
		tree: { usage: ["  harness tree [--json]"], run: treeCommand },
		parley: { usage: ["  harness parley show <slug>"], run: parleyCommand },
		rule: {
			usage: [
				"  harness rule [list [--kind <kind>] [--status <status>]]",
				"  harness rule (decide | retire | delete) <id>",
				"  harness rule edit <id> [--name <name>] [--kind <kind>] [--value <text>]",
				"  harness rule create --name <name> --kind <kind> --value <text>",
			],
			run: ruleCommand,
		},
		todo: {
			usage: [
				"  harness todo [list | add <text> | set <id> <state> [--text <text>] | sort]",
				"    [--handle <handle> | --conversation <id> | --task <key> | --project-list]",
			],
			run: todoCommand,
		},
		attach: {
			usage: ["  harness attach (<handle> | --conversation <id>) [--side]"],
			run: attachCommand,
		},
		inspect: {
			usage: ["  harness inspect [<handle> | --conversation <id>] [--port <n>] [--host <ip> | --tailscale]"],
			run: inspectCommand,
		},
		page: {
			usage: [
				"  harness page <folder> --slug <slug> [<handle> | --conversation <id>]",
				"    [--port <n>] [--host <ip> | --tailscale]",
			],
			run: pageCommand,
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
