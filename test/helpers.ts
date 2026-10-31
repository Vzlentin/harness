import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { Terminal } from "@earendil-works/pi-tui";
import { type Host, runHost } from "../src/host.ts";
import { MAIN_PROJECT, projectDir } from "../src/projects.ts";
import { statePaths } from "../src/protocol.ts";

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
	["No cwd", "No cwd child"],
	["Task:\nSend and wait", "Send and wait child"],
	["Agent spawn", "Agent child"],
	["Agent waits", "Agent gated"],
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
	const host = await runHost({ stateDir: statePaths(project).dir, project, cwd: projectDir(project), models });

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
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"HARNESS_HERDR_PANE",
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

/** A `pi` on `PATH` that logs its arguments and its Herdr variables to `log`, one line for each call, and exits with 3. */
export async function fakePi(): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const bin = await mkdtemp(join(root, "bin-"));
	const log = join(bin, "pi.log");

	const script = `#!/bin/sh
echo "$* HERDR_ENV=$HERDR_ENV HARNESS_HERDR_PANE=$HARNESS_HERDR_PANE" >> "${log}"
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

/** A terminal for a TUI that is not started: it keeps nothing and gives no input. */
export class FakeTerminal implements Terminal {
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
	setProgramStatus(): void {}
}
