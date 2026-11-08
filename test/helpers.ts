import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	getSystemMessageText,
	type Message,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderState,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { type Client, connect, request } from "../src/client/client.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { MAIN_PROJECT, projectDir } from "../src/protocol/projects.ts";
import type { ChildInfo, ChildKind, WatchLine } from "../src/protocol/requests.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

export let root: string;

/** One model request: what the faux provider saw. */
type Call = {
	readonly provider: string;
	readonly model: string;
	readonly thinking: string | undefined;
	readonly prompt: string;
};

export const calls: Call[] = [];

/** The texts of the user messages of the last request for each prompt, in order. */
export const contexts = new Map<string, string[]>();

/** The system prompt and the tools of the last request for each prompt. */
export const requests = new Map<string, { readonly system: string; readonly tools: readonly string[] }>();

/** Requests that wait for a test to release them, by prompt. */
export const gates = new Map<string, PromiseWithResolvers<void>>();

/** The prompts of gated requests that were aborted. */
export const aborted = new Set<string>();

export const models = createModels();
const environment = { ...process.env };

export function textOf(message: Message): string {
	if (message.role === "system") return "";
	const { content } = message;

	if (!Array.isArray(content)) return content;

	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The bash command a child runs for `Task:\nNest`: spawn a child with the same task, then wait for it. */
function nestCommand(): string {
	const cli = `"${process.execPath}" "${CLI}"`;

	return [
		`out=$(${cli} spawn --name nested --prompt Nest) || exit 1`,
		`echo "$out"`,
		`${cli} wait "$(echo "$out" | sed -n 's/.*(\\([a-z0-9]*\\))$/\\1/p')"`,
	].join("\n");
}

/** Prompts that call the `subagent` tool to spawn a child with the given prompt, then to wait for it. */
const toolSpawns = new Map([
	["Durable", "Durable child"],
	["Durable spawn", "Durable spawned"],
	["Task:\nNest tool", "Nest tool"],
	["Task:\nResume wait", "Resume wait child"],
	["No cwd", "No cwd child"],
	["Task:\nSend and wait", "Send and wait child"],
	["Agent spawn", "Agent child"],
	["Agent waits", "Agent gated"],
	["Overlay nest", "Read prompts/p.md"],
]);

/**
 * Prompts that call the `subagent` tool to spawn a child with the given arguments, then end their turn without a wait,
 * so the answer of the child comes back as a push.
 */
const pushSpawns = new Map<string, { readonly prompts: readonly string[]; readonly notify?: false }>([
	["Task:\nTree", { prompts: ["Tree branch"] }],
	["Task:\nTree branch", { prompts: ["Tree leaf"] }],
	["Task:\nQuiet parent", { prompts: ["Quiet child"], notify: false }],
]);

/** The handle of the child that each prompt of `pushSpawns` spawned. */
export const spawnedBy = new Map<string, string>();

/** The answer that the prompts `Schema` and `Schema text` give through the `respond` tool. */
export const SCHEMA_ANSWER = { verdict: "yes", score: 3 };

/** Resolved when the model asks the `subagent` tool to wait, by the prompt of the turn. */
export const toolWaits = new Map<string, PromiseWithResolvers<string>>();

/**
 * The cells that the model of a prompt runs with the `ipython` tool, one in each round, by prompt. After the last one,
 * it answers `Tool said: <result>`.
 */
export const cells = new Map<string, readonly string[]>();

/** The text of each tool result of the current turn of a prompt of `cells`, by prompt. */
export const cellResults = new Map<string, string[]>();

async function respond(
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	_state: FauxProviderState,
	model: { readonly id: string; readonly provider: string },
): Promise<AssistantMessage> {
	const messages = context.messages.filter((message) => message.role !== "system");
	const last = messages.at(-1);
	const lastUser = messages.findLast((message) => message.role === "user");
	const prompt = lastUser === undefined ? "" : textOf(lastUser);
	const child = toolSpawns.get(prompt);
	// Only the tool results of this turn count: the project agent keeps the turns before.
	const turn = lastUser === undefined ? messages : messages.slice(messages.indexOf(lastUser) + 1);

	if (child !== undefined && last?.role === "toolResult" && turn.filter((m) => m.role === "toolResult").length === 1) {
		const handle = /\(([a-z0-9]+)\)$/m.exec(textOf(last))?.[1];

		if (handle !== undefined) {
			toolWaits.get(prompt)?.resolve(handle);

			return fauxAssistantMessage(fauxToolCall("subagent", { action: "wait", handle }), { stopReason: "toolUse" });
		}
	}

	// After its spawn and wait, `Task:\nSend and wait` sends to the child and waits for it in one message.
	const results = messages.filter((m) => m.role === "toolResult");

	if (prompt === "Task:\nSend and wait" && last?.role === "toolResult" && results.length === 2) {
		const handle = /\(([a-z0-9]+)\)$/m.exec(results[0] === undefined ? "" : textOf(results[0]))?.[1];

		if (handle === undefined) throw new Error("no handle in the spawn result");

		const toolCalls = [
			fauxToolCall("subagent", { action: "send", handle, message: "Sent message" }),
			fauxToolCall("subagent", { action: "wait", handle }),
		];

		return fauxAssistantMessage(toolCalls, { stopReason: "toolUse" });
	}

	const cellCodes = cells.get(prompt);

	if (cellCodes !== undefined && last?.role === "toolResult") {
		const done = turn.flatMap((message) => (message.role === "toolResult" ? [textOf(message)] : []));
		cellResults.set(prompt, done);
		const code = cellCodes[done.length];

		if (code !== undefined) return fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" });
	}

	if (last?.role === "toolResult") {
		const handle = /^Spawned nested \(([a-z0-9]+)\)$/m.exec(textOf(last))?.[1];

		if (pushSpawns.has(prompt) && handle !== undefined) spawnedBy.set(prompt, handle);

		return fauxAssistantMessage(`Tool said: ${textOf(last)}`);
	}

	calls.push({ provider: model.provider, model: model.id, thinking: options?.reasoning, prompt });
	contexts.set(
		prompt,
		messages.flatMap((message) => (message.role === "user" ? [textOf(message)] : [])),
	);
	const [system] = context.messages;

	if (system?.role === "system") {
		requests.set(prompt, {
			system: getSystemMessageText(system),
			tools: (system.toolsAdded ?? []).map(({ name }) => name),
		});
	}

	const gate = gates.get(prompt);

	if (gate !== undefined) {
		await Promise.race([
			gate.promise,
			new Promise((_, reject) =>
				options?.signal?.addEventListener("abort", () => {
					aborted.add(prompt);
					reject(new Error("aborted"));
				}),
			),
		]);
	}

	if (cellCodes?.[0] !== undefined) {
		cellResults.set(prompt, []);

		return fauxAssistantMessage(fauxToolCall("ipython", { code: cellCodes[0] }), { stopReason: "toolUse" });
	}

	if (child !== undefined) {
		// The tests of these prompts are about `wait`, so the answer comes only through it.
		const args = { action: "spawn", name: "nested", prompts: [child], notify: false };

		return fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });
	}

	const push = pushSpawns.get(prompt);

	if (push !== undefined) {
		return fauxAssistantMessage(fauxToolCall("subagent", { action: "spawn", name: "nested", ...push }), {
			stopReason: "toolUse",
		});
	}

	const readPath = /^(?:Task:\n)?Read (.+)$/.exec(prompt)?.[1];

	if (readPath !== undefined) {
		return fauxAssistantMessage(fauxToolCall("read", { path: readPath }), { stopReason: "toolUse" });
	}

	if (prompt === "Task:\nUse a tool") {
		return fauxAssistantMessage(fauxToolCall("bash", { command: `while [ ! -f go ]; do sleep 0.05; done` }), {
			stopReason: "toolUse",
		});
	}

	if (prompt === "Task:\nCodemode") {
		const code = 'const run = await tools.bash({ command: "echo from the script" }); return run.output.toUpperCase();';

		return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
	}

	if (prompt === "Task:\nNest") {
		return fauxAssistantMessage(fauxToolCall("bash", { command: nestCommand() }), { stopReason: "toolUse" });
	}

	if (prompt === "Task:\nEnvironment") {
		const command = 'echo "$PI_SESSION_ID $PI_PROVIDER $PI_MODEL $PI_REASONING_LEVEL $HARNESS_PROJECT"';

		return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
	}

	if (prompt === "Task:\nMemory") {
		return fauxAssistantMessage(fauxToolCall("bash", { command: 'echo "${MEMORY_DIR-unset}"' }), {
			stopReason: "toolUse",
		});
	}

	if (prompt === "Task:\nFail") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });

	if (prompt === "Fail lines") {
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "  overloaded \nretry later" });
	}

	if (prompt === "Schema") {
		return fauxAssistantMessage(fauxToolCall("respond", { answer: SCHEMA_ANSWER }), { stopReason: "toolUse" });
	}

	if (prompt === "Schema text") {
		const args = { answer: JSON.stringify(SCHEMA_ANSWER) };

		return fauxAssistantMessage(fauxToolCall("respond", args), { stopReason: "toolUse" });
	}

	if (prompt === "Cut") return fauxAssistantMessage("cut", { stopReason: "length" });

	return fauxAssistantMessage(`Answer to ${prompt}`);
}

export type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Runs `subagent <args>` as a real process, in `cwd`, with `env` over the test environment. */
export function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd = root): Promise<Result> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
			// `code` is the exit code, or a string such as `ENOENT` when the process did not start.
			const code = error === null ? 0 : Number.isInteger(error.code) ? Number(error.code) : 1;
			resolve({ code, stdout, stderr });
		});
	});
}

/** What the socket at `path` sends for the raw line `line`, up to the end of the connection. */
export function rawReply(path: string, line: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		let reply = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => (reply += chunk));
		socket.once("error", reject);
		socket.once("end", () => resolve(reply));
		socket.write(`${line}\n`);
	});
}

/** The handle in `Spawned <handle>` or `Spawned <name> (<handle>)`. */
export function handleOf(result: Result): string {
	const handle = /^Spawned (?:.* \()?([a-z0-9]+)\)?$/m.exec(result.stdout)?.[1];

	if (handle === undefined) throw new Error(`no handle in ${JSON.stringify(result)}`);

	return handle;
}

/**
 * Runs the host of `project` in this process. It throws when another host has the lock, such as one that a CLI started
 * while the test host was down, because the tests would then run against a host without the faux provider.
 */
export async function startHost(project = MAIN_PROJECT): Promise<Host | undefined> {
	const host = await runHost({ project, cwd: projectDir(project), models });

	if (host === undefined) throw new Error(`another host has the lock of ${project}`);

	return host;
}

/** Polls `check` for up to 10 s. */
export async function until(check: () => boolean): Promise<void> {
	for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 50));

	if (!check()) throw new Error("timed out");
}

export function called(prompt: string): number {
	return calls.filter((call) => call.prompt === prompt).length;
}

/** Writes Pi's global settings of the tests, with `agentDepthLimit` when `limit` is set. */
export async function setDepthLimit(limit: number | undefined): Promise<void> {
	const settings =
		limit === undefined ? { retry: { enabled: false } } : { retry: { enabled: false }, agentDepthLimit: limit };

	await writeFile(join(root, "agent", "settings.json"), JSON.stringify(settings));
}

/** A watch of the project agent of the running host, with its first reply and its events. */
export async function watchAgent(): Promise<{
	client: Client;
	lines: { first: { child: ChildInfo }; events: WatchLine[] };
}> {
	const client = await connect({ start: false });

	if (client === undefined) throw new Error("no host");
	const first = await client.watch({ kind: "agent" });
	const events: WatchLine[] = [];
	void (async () => {
		for await (const line of first.lines) events.push(line);
	})();

	return { client, lines: { first, events } };
}

/** Sends `message` to the project agent and gives the verb. */
export async function inputAgent(client: Client, message: string): Promise<string> {
	const reply = await client.request({
		type: "input",
		requestId: `input-${message}`,
		handle: AGENT_HANDLE,
		message,
		followUp: false,
	});

	return reply.verb;
}

/** Waits for an idle event after a busy one. */
export async function untilIdleAfterBusy(events: readonly WatchLine[]): Promise<void> {
	const busy = () => events.findIndex((line) => !line.stopped && line.child.state === "busy");
	await until(
		() => busy() !== -1 && events.slice(busy() + 1).some((line) => !line.stopped && line.child.state === "idle"),
	);
}

/** Sends `message` to the project agent, and waits until its turn ends. */
export async function agentTurn(message: string): Promise<void> {
	const { client, lines } = await watchAgent();

	try {
		await inputAgent(client, message);
		await untilIdleAfterBusy(lines.events);
	} finally {
		client.close();
	}
}

/**
 * The options of a spawn through the socket: whether its answers are pushed, its kind, its request ID
 * (`<caller>:<prompt>` by default), and the project of its host.
 */
type SpawnOptions = {
	readonly notify: boolean;
	readonly kind?: ChildKind;
	readonly requestId?: string;
	readonly project?: string;
};

/** Spawns a child of `caller` with the first message `prompt` through the socket, as `rlm` or the tool does. */
export async function spawnAs(caller: string, prompt: string, options: SpawnOptions): Promise<ChildInfo> {
	const spawn = {
		type: "spawn",
		requestId: options.requestId ?? `${caller}:${prompt}`,
		caller,
		notify: options.notify,
		provider: "faux",
		model: "faux-1",
		callerThinking: "medium",
		cwd: root,
		prompt,
	} as const;

	const spawned = await request(options.kind === undefined ? spawn : { ...spawn, kind: options.kind }, {
		start: false,
		project: options.project,
	});

	if (spawned === undefined) throw new Error("no host");

	return spawned;
}

/** The answer that a `wait` for `handle` gives, in the host of `project`. */
export async function answerOf(handle: string, project?: string): Promise<string> {
	const reply = await request({ type: "wait", handle, timeout: 10 }, { start: false, project });

	if (reply === undefined) throw new Error("no host");

	return reply.answer;
}

/** Makes a temporary root with the agent dir, home and state, points `process.env` at it and sets up the faux provider. */
export async function setUp(): Promise<void> {
	// macOS limits a Unix socket path to 104 bytes, so the state stays short, under /tmp.
	root = await mkdtemp("/tmp/harness-");
	requests.clear();
	contexts.clear();
	await mkdir(join(root, "agent"));
	await mkdir(join(root, "home"));
	await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	replaceEnvironment({
		...environment,
		XDG_STATE_HOME: join(root, "state"),
		XDG_CONFIG_HOME: join(root, "config"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		HOME: join(root, "home"),
		PI_PROVIDER: "faux",
		PI_MODEL: "faux-1",
	});

	for (const name of [
		"PI_SESSION_ID",
		"PI_REASONING_LEVEL",
		"PI_SESSION_FILE",
		"HC_TERMINAL_ID",
		"HARNESS_PROJECT",
		"MEMORY_DIR",
		// Node warns on stderr when both are set, and the tests compare stderr.
		"FORCE_COLOR",
		"NO_COLOR",
	]) {
		delete process.env[name];
	}

	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "faux-1", reasoning: true },
			{ id: "faux-2", reasoning: true },
		],
	});

	faux.setResponses(Array.from({ length: 500 }, () => respond));
	models.setProvider(faux.provider);
}

/**
 * Makes `values` the environment of this process. It changes `process.env` in place, so `os.homedir()` also reads the
 * new `HOME`.
 */
function replaceEnvironment(values: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(process.env)) if (!Object.hasOwn(values, name)) delete process.env[name];

	for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
}

/** Restores `process.env` and removes the temporary root. */
export async function tearDown(): Promise<void> {
	replaceEnvironment(environment);
	await rm(root, { recursive: true, force: true });
}

/** A `pi` on `PATH` that logs its arguments and `HARNESS_PROJECT` to `log`, one line for each call, and exits with 3. */
export async function fakePi(): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const bin = await mkdtemp(join(root, "bin-"));
	const log = join(bin, "pi.log");

	const script = `#!/bin/sh
echo "$* HARNESS_PROJECT=$HARNESS_PROJECT" >> "${log}"
exit 3
`;

	await writeFile(join(bin, "pi"), script);
	await chmod(join(bin, "pi"), 0o755);

	return { env: { PATH: `${bin}:${process.env.PATH}` }, log };
}

/** The lines of the log file `log`, or none when it does not exist. */
export function logLines(log: string): string[] {
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

/** A terminal for a TUI that is not started: it keeps only the program statuses that it gets, and gives no input. */
export class FakeTerminal implements Terminal {
	readonly statuses: ProgramStatus[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return 100;
	}
	get rows(): number {
		return 40;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(status: ProgramStatus): void {
		this.statuses.push(status);
	}
}
