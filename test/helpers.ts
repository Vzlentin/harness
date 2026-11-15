import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	getSystemMessageText,
	type Message,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderState,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantEntry,
	type ConversationView,
	createRegistry,
	type Extension,
	Harness,
	type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Component, ProgramStatus, Terminal, TUI } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { expect, vi } from "vite-plus/test";
import { AnswerListener, type AnswersOptions } from "../src/client/answers.ts";
import { type Client, connect, request } from "../src/client/client.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { AskWrite } from "../src/protocol/project.ts";
import { MAIN_PROJECT, projectDir } from "../src/protocol/projects.ts";
import type { ChildInfo, Delivery, Replies, Request, ServesInput, WatchLine } from "../src/protocol/requests.ts";
import { StoreFile } from "../src/protocol/store-file.ts";
import { AGENT_HANDLE, type Target } from "../src/protocol/target.ts";
import { TODO_LIST_KIND } from "../src/protocol/todo.ts";

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

/** The role of the message before the last user message of the last request for each prompt. */
export const before = new Map<string, Message["role"] | undefined>();

/**
 * The system prompt and the tools of the last request for each prompt: their names, their full declarations, and the
 * sections that the model has, from all the system messages of the request in order.
 */
export const requests = new Map<
	string,
	{
		readonly system: string;
		readonly tools: readonly string[];
		readonly declarations: readonly Tool[];
		readonly sections: Readonly<Record<string, string>>;
	}
>();

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

/** The sections that the model has after `messages`: each system message sets a section, or removes it with `null`. */
function replayedSections(messages: readonly Message[]) {
	const sections: Record<string, string> = {};

	for (const message of messages) {
		if (message.role !== "system") continue;

		for (const [name, text] of Object.entries(message.sections ?? {})) {
			if (text === null) delete sections[name];
			else sections[name] = text;
		}
	}

	return sections;
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
	["Task:\nNest default", "Nest default child"],
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

/**
 * The prompt of a child for a query: its model thinks `Secret thinking`, writes `I list the files`, calls `bash` with
 * `QUERIED_CALL`, whose output is `421234`, then answers `Listed the files`.
 */
export const QUERIED = "Queried";

export const QUERIED_CALL = { command: "echo $((6*7))1234" };

/** The answer that the prompts `Schema` and `Schema text` give through the `respond` tool. */
export const SCHEMA_ANSWER = { verdict: "yes", score: 3 };

/** Resolved when the model asks the `subagent` tool to wait, by the prompt of the turn. */
export const toolWaits = new Map<string, PromiseWithResolvers<string>>();

/** One tool call of the model: the name of the tool and its arguments. */
type ScriptedCall = { readonly name: string; readonly arguments: ToolCall["arguments"] };

/**
 * The tool calls that the model of a prompt makes, one in each round, by prompt. After the last one, it answers
 * `Tool said: <result>`.
 */
export const scripts = new Map<string, readonly ScriptedCall[]>();

/** The cells that the model of a prompt runs with the `ipython` tool, as `scripts` runs its calls, by prompt. */
export const cells = new Map<string, readonly string[]>();

/** The text of each tool result of the current turn of a prompt of `scripts` or `cells`, by prompt. */
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

	const script = scripts.get(prompt) ?? cells.get(prompt)?.map((code) => ({ name: "ipython", arguments: { code } }));

	if (script !== undefined && last?.role === "toolResult") {
		const done = turn.flatMap((message) => (message.role === "toolResult" ? [textOf(message)] : []));
		cellResults.set(prompt, done);
		const next = script[done.length];

		if (next !== undefined) {
			return fauxAssistantMessage(fauxToolCall(next.name, next.arguments), { stopReason: "toolUse" });
		}
	}

	if (prompt === QUERIED) {
		if (last?.role === "toolResult") return fauxAssistantMessage("Listed the files");
		const content = [fauxThinking("Secret thinking"), fauxText("I list the files"), fauxToolCall("bash", QUERIED_CALL)];

		return fauxAssistantMessage(content, { stopReason: "toolUse" });
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
	before.set(prompt, lastUser === undefined ? undefined : messages[messages.indexOf(lastUser) - 1]?.role);
	const [system] = context.messages;

	if (system?.role === "system") {
		requests.set(prompt, {
			system: getSystemMessageText(system),
			tools: (system.toolsAdded ?? []).map(({ name }) => name),
			declarations: system.toolsAdded ?? [],
			sections: replayedSections(context.messages),
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

	const [first] = script ?? [];

	if (first !== undefined) {
		cellResults.set(prompt, []);

		return fauxAssistantMessage(fauxToolCall(first.name, first.arguments), { stopReason: "toolUse" });
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

	if (prompt.startsWith("Fixture codemode tools")) {
		return fauxAssistantMessage(
			fauxToolCall("codemode", { code: 'return ALL_TOOLS.map((tool) => tool.name).join(" ");' }),
			{
				stopReason: "toolUse",
			},
		);
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
export async function startHost(
	project = MAIN_PROJECT,
	options: { readonly sessionEndMs?: number } = {},
): Promise<Host> {
	const host = await runHost({ project, cwd: projectDir(project), models, ...options });

	if (host === undefined) throw new Error(`another host has the lock of ${project}`);

	return host;
}

/** Adds the project `name` with a new directory, and gives the directory. */
export async function createProject(name: string): Promise<string> {
	const dir = await mkdtemp(join(root, `${name}-`));
	expect((await cli(["create", name, "--cwd", dir])).code).toBe(0);

	return dir;
}

/** Adds the project `name` with a new directory, and runs its host in this process. */
export async function projectHost(name: string): Promise<Host> {
	await createProject(name);

	return startHost(name);
}

/** `store.json` of `project`, as a program with no host reads it, or undefined while it does not exist. */
export function readStoreFile(project: string): StoreFile | undefined {
	const path = statePaths(project).store;

	if (!existsSync(path)) return undefined;

	return Value.Parse(StoreFile, JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Connects to the host process of `project` and starts it when no host listens, as a command does. When the started host
 * is still starting after the 10 s of `connect`, as on a loaded machine, it waits up to 10 s more until the host listens.
 */
export async function startHostProcess(project = MAIN_PROJECT): Promise<Client> {
	let client: Client | undefined;

	try {
		client = await connect({ start: true, project });
	} catch (error) {
		if (!(error instanceof Error && error.message.includes(" is still starting: "))) throw error;
	}

	return (
		client ??
		vi.waitFor(
			async () => {
				const started = await connect({ start: false, project });

				if (started === undefined) throw new Error(`The host of ${project} does not listen yet`);

				return started;
			},
			{ timeout: 10_000, interval: 100 },
		)
	);
}

/** Polls `check` for up to 10 s. */
export async function until(check: () => boolean): Promise<void> {
	for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 50));

	if (!check()) throw new Error("timed out");
}

export function called(prompt: string): number {
	return calls.filter((call) => call.prompt === prompt).length;
}

/** The keys of Pi's global settings that the tests set. */
export type TestSettings = {
	readonly agentDepthLimit?: number;
	readonly subagentModel?: string;
	readonly subagentThinkingLevel?: string;
	readonly queryModel?: string;
	readonly packages?: readonly string[];
};

/** Writes Pi's global settings of the tests: no retry, and `settings`. */
export async function setSettings(settings: TestSettings = {}): Promise<void> {
	await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, ...settings }));
}

/**
 * A watch of `target` in the running host, on a connection of its own: the reply, the lines that came so far, and the
 * end of the lines.
 */
export async function openWatch(target: Target): Promise<{
	client: Client;
	view: ConversationView;
	child: ChildInfo;
	lines: WatchLine[];
	ended: Promise<void>;
}> {
	const client = await connect({ start: false });

	if (client === undefined) throw new Error("no host");
	const watched = await client.watch(target);
	const lines: WatchLine[] = [];

	const ended = (async () => {
		for await (const line of watched.lines) lines.push(line);
	})();

	return { client, view: watched.view, child: watched.child, lines, ended };
}

/** The lists of todos that the list events of `lines` gave, in order. */
export function listsOf(lines: readonly WatchLine[]): unknown[] {
	return lines.flatMap((line) => {
		if ("view" in line.change) return [];
		const list = line.change.docs?.[TODO_LIST_KIND];

		return list === undefined ? [] : [list];
	});
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
	const busy = () => events.findIndex((line) => line.child.state === "busy");
	await until(() => busy() !== -1 && events.slice(busy() + 1).some((line) => line.child.state === "idle"));
}

/** Sends `message` to the project agent, and waits until its turn ends. */
export async function agentTurn(message: string): Promise<void> {
	const { client, lines } = await openWatch({ kind: "agent" });

	try {
		await inputAgent(client, message);
		await untilIdleAfterBusy(lines);
	} finally {
		client.close();
	}
}

/**
 * The options of a spawn through the socket: whether its answers are pushed, its request ID
 * (`<caller>:<prompt>` by default), the project of its host, and what the child serves.
 */
type SpawnOptions = {
	readonly notify: boolean;
	readonly requestId?: string;
	readonly project?: string;
	readonly serves?: ServesInput;
};

/** Spawns a child of `caller` with the first message `prompt` through the socket, as the tool does. */
export async function spawnAs(caller: string, prompt: string, options: SpawnOptions): Promise<ChildInfo> {
	let spawn: Extract<Request, { type: "spawn" }> = {
		type: "spawn",
		requestId: options.requestId ?? `${caller}:${prompt}`,
		caller,
		notify: options.notify,
		provider: "faux",
		model: "faux-1",
		callerThinking: "medium",
		cwd: root,
		prompt,
	};

	if (options.serves !== undefined) spawn = { ...spawn, serves: options.serves };

	const spawned = await request(spawn, {
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

/**
 * The handle and the conversation ID of a new child of `caller`, which prints its `PI_SESSION_ID`, and serves `serves`.
 * The request ID comes from `requestId`, by default the caller.
 */
export async function spawnWithId(
	caller: string,
	options: { readonly serves?: ServesInput; readonly requestId?: string } = {},
): Promise<{ handle: string; id: string }> {
	const child = await spawnAs(caller, "Task:\nEnvironment", { notify: false, ...options });
	const id = /^Tool said: (\d+) /.exec(await answerOf(child.handle))?.[1];

	if (id === undefined) throw new Error("no conversation ID");

	return { handle: child.handle, id };
}

/** Sends `line` to the host of `project`, the main project by default, through the socket. */
export async function send<T extends Request["type"]>(
	line: Extract<Request, { type: T }>,
	project?: string,
): Promise<Replies[T]> {
	const reply = await request(line, { start: false, project });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/** Writes a round of `asks` for the parley `parley` as the caller `caller`, and gives the reply. */
export async function round(
	caller: string,
	parley: Extract<Request, { type: "ask"; action: "round" }>["parley"],
	asks: Extract<Request, { type: "ask"; action: "round" }>["asks"],
): Promise<AskWrite> {
	const line = parley === undefined ? { asks } : { parley, asks };

	return Value.Parse(AskWrite, await send({ type: "ask", action: "round", caller, ...line }));
}

/** Writes `answers` as the caller `user`, and gives the reply. */
export async function answer(
	answers: Extract<Request, { type: "ask"; action: "answer" }>["answers"],
): Promise<AskWrite> {
	return Value.Parse(AskWrite, await send({ type: "ask", action: "answer", caller: "user", answers }));
}

/** The options of the call of `framed`. */
export const OPTIONS = [
	{ key: "a", label: "In the store", gains: ["One writer"], costs: ["A protocol bump"] },
	{ key: "b", label: "In files" },
];

/** A parley `slug` with one call, its design sense and a read-back: the IDs of its call and of its read-back. */
export async function framed(slug: string): Promise<{ call: number; readBack: number }> {
	const written = await round(
		"pi-1",
		{ slug, title: "Where asks live", goal: "Pick the place.", design_sense: "One writer." },
		[{ title: "Where", kind: "your call", options: OPTIONS, plan: "a" }, { title: "These are the terms" }],
	);

	const [call, readBack] = (written.parleys[0]?.asks ?? []).map((ask) => ask.id);

	if (call === undefined || readBack === undefined) throw new Error("no asks");

	return { call, readBack };
}

/** The state of the child `handle` of the main host, or nothing when no host runs. */
export async function stateOf(handle: string): Promise<string | undefined> {
	return (await request({ type: "status", handle }, { start: false }))?.state;
}

/** Waits until the child `handle` of the main host has the state `state`. */
export async function untilState(handle: string, state: string): Promise<void> {
	await vi.waitFor(async () => expect(await stateOf(handle)).toBe(state), { timeout: 10_000 });
}

/** An `answers` listener, every delivery that it gave, and every error of a delivery. */
export type Answers = { readonly deliveries: Delivery[]; readonly errors: Error[]; readonly listener: AnswerListener };

/**
 * The `answers` listener of `caller`, as the Pi extension opens it, with every delivery that came. `onDelivery` runs
 * after each delivery is kept.
 */
export function listenAnswers(
	caller: string,
	options: Omit<AnswersOptions, "onError"> = { start: false },
	onDelivery: (delivery: Delivery) => void = () => {},
): Answers {
	const deliveries: Delivery[] = [];
	const errors: Error[] = [];

	const listener = new AnswerListener(
		caller,
		(delivery) => {
			deliveries.push(delivery);
			onDelivery(delivery);
		},
		{ ...options, onError: (error) => errors.push(error) },
	);

	return { deliveries, errors, listener };
}

/** What the pi-durable test hosts report, such as a structured output that does not match the tool's schema. */
export const reports: unknown[] = [];

/** A pi-durable host over `store` with `extensions`, which adds its reports to `reports`. */
export async function openDurableHost(store: string, extensions: readonly Extension[]): Promise<Harness> {
	const registry = createRegistry();

	for (const extension of extensions) registry.install(extension);

	return Harness.open(
		await openNodeSqliteStorage(store),
		{ models, registry, onReport: (report) => reports.push(report) },
		BACKGROUND_CONTEXT,
	);
}

/**
 * The content of the first assistant message of the answer of `settled`, a submission of `harness`. It throws when the
 * submission is not done or has no answer.
 */
export async function answerContent(
	harness: Harness,
	settled: SettledSubmissionRecord,
): Promise<AssistantMessage["content"]> {
	if (settled.status !== "done" || settled.answer === undefined) throw new Error(JSON.stringify(settled));
	const answer = settled.answer;
	const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), BACKGROUND_CONTEXT);
	const message = entry?.model?.[0];

	return message?.role === "assistant" ? message.content : [];
}

/** Makes a temporary root with the agent dir, home and state, points `process.env` at it and sets up the faux provider. */
export async function setUp(): Promise<void> {
	// macOS limits a Unix socket path to 104 bytes, so the state stays short, under /tmp.
	root = await mkdtemp("/tmp/harness-");
	requests.clear();
	contexts.clear();
	before.clear();
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
			// A context window that holds a transcript over the bound of a query with no compaction.
			{ id: "faux-wide", reasoning: true, contextWindow: 4_000_000 },
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

/** The output of `hc get --json t3` for the terminal `t3` of the caller, in the space `s1` and the tab `b2`. */
export const CALLER = JSON.stringify({ address: "t3", labels: { "herdr.space": "s1", "herdr.tab": "b2" } });

/**
 * An `hc` on `PATH` that logs its arguments to `log`, one line for each call, and prints `terminal` for `get`. Its
 * environment is that of the hc terminal `t3`. With `fail`, each call whose first word is `failOn` writes `fail` to
 * stderr and exits with 1, after the log line.
 */
export async function fakeHc(
	terminal = CALLER,
	fail?: string,
	failOn = "run",
): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const bin = await mkdtemp(join(root, "bin-"));
	const log = join(bin, "hc.log");

	const script = `#!/bin/sh
echo "$*" >> "${log}"
${fail === undefined ? "" : `if [ "$1" = "${failOn}" ]; then echo '${fail}' >&2; exit 1; fi`}
if [ "$1" = "get" ]; then echo '${terminal}'; fi
`;

	await writeFile(join(bin, "hc"), script);
	await chmod(join(bin, "hc"), 0o755);

	return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HC_TERMINAL_ID: "t3" }, log };
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

/**
 * Makes the component of the widget factory `factory` with a TUI whose `requestRender` draws it at `width` columns
 * into `renders`, and draws it once, as Pi does when it sets a widget.
 */
export function drawWidget(
	factory: (tui: TUI, theme: Theme) => Component,
	theme: Pick<Theme, "fg">,
	renders: (readonly string[])[],
	width = 80,
): void {
	let component: Component | undefined;

	const tui: Pick<TUI, "requestRender"> = {
		requestRender: () => {
			if (component !== undefined) renders.push(component.render(width));
		},
	};

	// SAFETY: the widgets of the extension use only `requestRender` of the TUI, and `fg` of the theme.
	component = factory(tui as TUI, theme as Theme);
	tui.requestRender();
}
