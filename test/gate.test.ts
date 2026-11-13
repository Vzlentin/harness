import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { type GateHost, gateCall } from "../src/host/gate.ts";
import { addPerson, addThread, approveHeld, holdAction, logMessage, setRule } from "../src/host/project.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { GateReply } from "../src/protocol/gate.ts";
import { onLines } from "../src/protocol/lines.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { type HeldAction, Message, Person, ProjectEvent, ProjectState, Rule, Thread } from "../src/protocol/project.ts";
import { MAIN_PROJECT } from "../src/protocol/projects.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import {
	agentTurn,
	cellResults,
	cli,
	models,
	openDurableHost,
	root,
	scripts,
	setUp,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gate-cases.json");

/** The rules and the cases of the spike of 13 Nov, with the result that each case expects. */
const GateCases = Type.Object({
	rules: Type.Array(Type.String()),
	cases: Type.Array(
		Type.Object({
			id: Type.String(),
			writes: Type.Boolean(),
			expect: Type.Union([Type.Literal("held"), Type.Literal("runs")]),
			last_user: Type.Array(Type.String()),
			action: Type.String(),
		}),
	),
});

const { rules: RULES, cases: CASES } = Value.Parse(GateCases, JSON.parse(readFileSync(FIXTURE, "utf8")));

/**
 * The rule that each held case breaks, by the name of the rule, as the page of the spike names it where it does. The
 * fixture records only the results.
 */
const BROKEN: ReadonlyMap<string, string> = new Map([
	["a01-sheet-invented", "R4"],
	["a02-merge-alone", "R4"],
	["a04-mr-note-others", "R4"],
	["a05-curl-merge", "R4"],
	["a07-push-master", "R6"],
	["a09-jira-comment-no-go", "R4"],
	["a10-rule-change-agent", "R5"],
	["a11-deploy-prod", "R4"],
	["a18-python-post", "R4"],
	["a19-airflow-trigger", "R4"],
]);

/** The state of step 1. */
const WritesState = Type.Object({ command: Type.String() }, { additionalProperties: false });

/** The state of step 2. */
const RuleState = Type.Object(
	{ action: Type.String(), last_user_messages: Type.Array(Type.String()) },
	{ additionalProperties: false },
);

/** The recorded answers of the classifier for one command: step 1, and the choice of step 2. */
type Recorded = { readonly writes: number; readonly rule: string };

/** The answers of the classifier, by command. A command that it does not have fails the call. */
const recorded = new Map<string, Recorded>();

/**
 * The choices of step 2 by the JSON text of the command and the messages, in place of the choice of `recorded`: two
 * cases of the spike have the same command, with other messages.
 */
const chosen = new Map<string, string>();

/** The IDs of the decided conduct rules, which step 2 must give as its only choices with `none`. */
let conduct: readonly string[] = [];

/** Whether the classifier provider has a credential. */
let loggedIn = true;

/** The model and the context of each call of the classifier. */
const asked: { readonly model: string; readonly context: ClassifierContext }[] = [];

function classifierModel(id: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "test-gate",
		provider: "openrouter",
		baseUrl: "http://gate.test",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
	};
}

/**
 * The classifier of the tests: it gives the recorded answers of the command. It fails when the state or the questions
 * are not those of a step, when step 2 has other choices than `none` and the decided conduct rules, and for a command
 * with no recorded answers.
 */
async function classify(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	_options?: ClassifierOptions,
): Promise<ClassifierResult> {
	asked.push({ model: model.id, context });
	const result = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
	const { state, questions } = context;

	if (Value.Check(WritesState, state) && questions.writes?.type === "bool") {
		const answer = recorded.get(state.command);

		if (answer === undefined) return { ...result, answers: {}, stopReason: "error", errorMessage: "overloaded" };

		return { ...result, answers: { writes: { type: "bool", probability: answer.writes } }, stopReason: "stop" };
	}

	const question = questions.rule;

	if (!Value.Check(RuleState, state) || question?.type !== "choice") throw new Error("not a question of the gate");

	const choices = Object.keys(question.criteria).toSorted();

	if (JSON.stringify(choices) !== JSON.stringify(["none", ...conduct].toSorted())) {
		throw new Error(`unexpected choices: ${choices.join(", ")}`);
	}

	const choice =
		chosen.get(JSON.stringify([state.action, state.last_user_messages])) ?? recorded.get(state.action)?.rule ?? "none";

	const answers = { rule: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 } } as const;

	return { ...result, answers, stopReason: "stop" };
}

/** Sends `line` to the host of `project` through the socket. */
async function send<T extends Request["type"]>(
	line: Extract<Request, { type: T }>,
	project?: string,
): Promise<Replies[T]> {
	const reply = await request(line, { start: false, project });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/** Runs the host of the new project `name` in this process. */
async function projectHost(name: string): Promise<Host> {
	const dir = await mkdtemp(join(root, `${name}-`));
	expect((await cli(["create", name, "--cwd", dir])).code).toBe(0);
	const host = await runHost({ project: name, cwd: dir, models });

	if (host === undefined) throw new Error("no host");

	return host;
}

/** The ID of a new message of the user in a new thread of `project`, the source of the rules of a test. */
async function sourceMessage(project: string): Promise<number> {
	const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

	const thread = Value.Parse(
		Thread,
		await send({ type: "thread", action: "add", topic: "Rules", persons: [sam.id] }, project),
	);

	const log = {
		type: "message",
		action: "log",
		caller: "cli",
		thread: thread.id,
		from: "user",
		direction: "in",
	} as const;

	return Value.Parse(Message, await send({ ...log, text: "The rules." }, project)).id;
}

/** The fields of a new rule of the tests. */
type RuleFields = Pick<Rule, "name" | "kind" | "value" | "status">;

/** Adds the rule `fields`, said by the user in the message `source`, to the store of `project`, and gives it. */
async function addRule(project: string, source: number, fields: RuleFields): Promise<Rule> {
	const line = { type: "rule", action: "set", caller: "cli", ...fields, saidBy: "user", source } as const;

	return Value.Parse(Rule, await send(line, project));
}

/** The reply of `gate` for a `bash` call of `command` by `caller`, with the ID `requestId`. */
async function gate(
	caller: string,
	requestId: string,
	command: string,
	project?: string,
	messages: readonly string[] = ["continue"],
): Promise<GateReply> {
	const line = {
		type: "gate",
		requestId,
		caller,
		tool: "bash",
		arguments: { command },
		messages: [...messages],
	} as const;

	return Value.Parse(GateReply, await send(line, project));
}

/** The held action of a reply that holds the call. */
function heldOf(reply: GateReply): HeldAction {
	if (reply.runs) throw new Error("the call runs");

	return reply.held;
}

/** A `watch-project` of `project` on a socket of its own, with the events that came so far. */
async function watchProject(project: string): Promise<{ socket: Socket; events: ProjectEvent[] }> {
	const socket = createConnection(statePaths(project).socket);
	await once(socket, "connect");
	const events: ProjectEvent[] = [];
	let replied = false;

	onLines(socket, (line) => {
		const parsed: unknown = JSON.parse(line);

		if (Value.Check(Type.Object({ ok: Type.Literal(true), value: ProjectState }), parsed)) replied = true;
		else events.push(Value.Parse(Type.Object({ event: ProjectEvent }), parsed).event);
	});

	socket.write(`${JSON.stringify({ type: "watch-project" })}\n`);
	await until(() => replied);

	return { socket, events };
}

/** Writes Pi's global settings of the tests, with `gateClassifier` when it is given. */
async function setGateClassifier(name: string | undefined): Promise<void> {
	const settings =
		name === undefined ? { retry: { enabled: false } } : { retry: { enabled: false }, gateClassifier: name };

	await writeFile(join(root, "agent", "settings.json"), JSON.stringify(settings));
}

beforeAll(async () => {
	await setUp();

	models.setProvider(
		createProvider({
			id: "openrouter",
			auth: { apiKey: { name: "Test key", resolve: async () => (loggedIn ? { auth: {} } : undefined) } },
			models: [classifierModel("typesafe/jev-1.14"), classifierModel("typesafe/jev-small")],
			classifiers: { "test-gate": { classify } },
		}),
	);
});

afterAll(async () => {
	await tearDown();
});

beforeEach(async () => {
	loggedIn = true;
	asked.length = 0;
	recorded.clear();
	chosen.clear();
	conduct = [];
	await setGateClassifier(undefined);
});

describe("gate", { timeout: 60_000 }, () => {
	it("gives the result of each case of the spike, and holds a call with the rule that it breaks", async () => {
		const project = "gate-cases";
		const host = await projectHost(project);

		try {
			const source = await sourceMessage(project);
			const rules: Rule[] = [];

			// `R<n> <text>` is a conduct rule named `R<n>`, and `Domain: <text>` a domain rule. All are decided.
			for (const [index, text] of RULES.entries()) {
				const named = /^(R\d) (.+)$/.exec(text);

				const fields: RuleFields =
					named === null
						? { name: `D${index}`, kind: "domain", value: text.replace(/^Domain: /, ""), status: "decided" }
						: { name: named[1] ?? "", kind: "conduct", value: named[2] ?? "", status: "decided" };

				rules.push(await addRule(project, source, fields));
			}

			conduct = rules.flatMap((rule) => (rule.kind === "conduct" ? [String(rule.id)] : []));
			const byName = new Map(rules.map((rule) => [rule.name, rule]));

			for (const found of CASES) {
				const rule = byName.get(BROKEN.get(found.id) ?? "")?.id.toString() ?? "none";
				recorded.set(found.action, { writes: found.writes ? 0.98 : 0.02, rule: "none" });
				chosen.set(JSON.stringify([found.action, found.last_user]), rule);
			}

			for (const found of CASES) {
				asked.length = 0;
				const reply = await gate("agent", found.id, found.action, project, found.last_user);
				const broken = byName.get(BROKEN.get(found.id) ?? "");

				expect(reply.runs ? "runs" : "held", found.id).toBe(found.expect);
				// Step 1 has only the command, and step 2 the command and the messages of the user.
				expect(
					asked.map(({ context }) => context.state),
					found.id,
				).toEqual(
					found.writes
						? [{ command: found.action }, { action: found.action, last_user_messages: found.last_user }]
						: [{ command: found.action }],
				);

				if (broken !== undefined) {
					expect(heldOf(reply), found.id).toMatchObject({
						state: "held",
						requestId: found.id,
						agent: "agent",
						tool: "bash",
						command: found.action,
						rule: broken.id,
						reason: `It breaks rule ${broken.id} ${broken.name}: ${broken.value}`,
						by: "agent",
					});
				}
			}

			// The stub refuses other choices, so a domain rule is not a choice of step 2.
			expect(conduct).toEqual(["1", "2", "3", "4", "5", "6"]);
		} finally {
			await host.close();
		}
	});

	it("asks nothing about a read, nor in a project with no decided conduct rule, and holds a call when the gate fails", async () => {
		const project = "gate-reads";
		const host = await projectHost(project);
		const push = "git push origin HEAD:master";

		try {
			const source = await sourceMessage(project);
			recorded.set(push, { writes: 0.98, rule: "3" });
			// A decided domain rule and an open conduct rule are not decided conduct rules.
			await addRule(project, source, { name: "scope", kind: "domain", value: "Types 45 and 54.", status: "decided" });
			await addRule(project, source, { name: "ask", kind: "conduct", value: "Ask first.", status: "open" });
			expect(await gate("agent", "push", push, project)).toEqual({ runs: true });

			const rule = await addRule(project, source, {
				name: "master",
				kind: "conduct",
				value: "No push to master.",
				status: "decided",
			});

			conduct = [String(rule.id)];

			const reads = [
				{ tool: "read", arguments: { path: "README.md" } },
				{ tool: "grep", arguments: { pattern: "x" } },
				{ tool: "find", arguments: { pattern: "*.ts" } },
				{ tool: "ls", arguments: {} },
				{ tool: "thread", arguments: { action: "list" } },
				{ tool: "thread", arguments: { action: "read", thread: 1 } },
				{ tool: "rule", arguments: { action: "list" } },
				{ tool: "term", arguments: { action: "list" } },
				{ tool: "part", arguments: { action: "list" } },
			];

			for (const [index, call] of reads.entries()) {
				const line = { type: "gate", requestId: `read-${index}`, caller: "agent", messages: [], ...call } as const;
				expect(await send(line, project)).toEqual({ runs: true });
			}

			expect(asked).toEqual([]);
			expect(heldOf(await gate("agent", "push-decided", push, project))).toMatchObject({ id: 1, rule: rule.id });
			// Step 1 at 0.5 is not above 0.5: the call runs.
			recorded.set("git push origin feature", { writes: 0.5, rule: "3" });
			expect(await gate("agent", "push-feature", "git push origin feature", project)).toEqual({ runs: true });

			// A write of the store asks, with the tool and its JSON arguments as the command. With no answer, the
			// classifier fails, and the gate holds the call with no rule.
			const args = { action: "set", id: 1, status: "retired", saidBy: "user", source };

			const line = {
				type: "gate",
				requestId: "rule-set",
				caller: "agent",
				tool: "rule",
				arguments: args,
				messages: [],
			} as const;

			const failed = heldOf(Value.Parse(GateReply, await send(line, project)));
			expect(failed).toMatchObject({
				id: 2,
				command: `rule ${JSON.stringify(args)}`,
				reason: "The classifier openrouter/typesafe/jev-1.14 failed: overloaded",
			});
			expect(failed.rule).toBeUndefined();

			// With no credential, the gate holds the call with that reason.
			loggedIn = false;
			const unchecked = heldOf(await gate("agent", "no-credential", "git push origin feature", project));
			expect(unchecked).toMatchObject({ id: 3, reason: "No classifier: log in to openrouter or set gateClassifier" });
			expect(unchecked.rule).toBeUndefined();
			loggedIn = true;

			// The classifier is the one of `gateClassifier`.
			asked.length = 0;
			await setGateClassifier("openrouter/typesafe/jev-small");
			await gate("agent", "small", push, project);
			expect(asked.map(({ model }) => model)).toEqual(["typesafe/jev-small", "typesafe/jev-small"]);
		} finally {
			await host.close();
		}
	});

	it("gives a held call again, runs an approved command once for its agent, and shows the held actions in the watch", async () => {
		const project = "gate-held";
		const host = await projectHost(project);
		const merge = "glab mr merge 6 --yes";
		const watch = await watchProject(project);

		try {
			const source = await sourceMessage(project);

			const rule = await addRule(project, source, {
				name: "go",
				kind: "conduct",
				value: "Merge only with a go.",
				status: "decided",
			});

			conduct = [String(rule.id)];
			recorded.set(merge, { writes: 0.98, rule: String(rule.id) });
			const held = heldOf(await gate("khan", "call-1", merge, project));
			asked.length = 0;

			// The same call again, such as a hook after a restart, gets the same action, with no question.
			expect(await gate("khan", "call-1", merge, project)).toEqual({ runs: false, held });
			expect(asked).toEqual([]);
			await until(() => watch.events.some((event) => event.held.length > 0));
			expect(watch.events.at(-1)).toMatchObject({ held: [held], rules: [], removed: { held: [] } });

			const approved = await send({ type: "held", action: "approve", caller: "user", id: held.id }, project);
			expect(approved).toMatchObject({ id: held.id, state: "approved", by: "user" });
			expect(approved).not.toHaveProperty("ran");
			await expect(send({ type: "held", action: "drop", caller: "user", id: held.id }, project)).rejects.toThrow(
				`Held action ${held.id} is approved, not held`,
			);
			await until(() => watch.events.at(-1)?.held[0]?.state === "approved");

			// Another agent, or another command, is not approved.
			expect(heldOf(await gate("other", "call-2", merge, project))).toMatchObject({ id: 2, agent: "other" });
			expect(heldOf(await gate("khan", "call-3", `${merge} --squash`, project))).toMatchObject({ id: 3 });
			asked.length = 0;

			// The approved command of the agent runs once, also when the same call comes again, with no question.
			expect(await gate("khan", "call-4", merge, project)).toEqual({ runs: true });
			expect(await gate("khan", "call-4", merge, project)).toEqual({ runs: true });
			expect(asked).toEqual([]);
			await until(() => watch.events.at(-1)?.held.some((found) => found.id === held.id) === true);
			expect(watch.events.at(-1)?.held).toEqual([
				{ ...approved, ran: { requestId: "call-4", at: expect.any(Number) } },
			]);

			// A later call of the same command is asked again, and held as a new action.
			expect(heldOf(await gate("khan", "call-5", merge, project))).toMatchObject({ id: 4, state: "held" });

			const dropped = await send({ type: "held", action: "drop", caller: "user", id: 2 }, project);
			expect(dropped).toMatchObject({ id: 2, state: "dropped", by: "user" });
			expect(await gate("other", "call-2", merge, project)).toEqual({ runs: false, held: dropped });
			await expect(send({ type: "held", action: "approve", caller: "user", id: 9 }, project)).rejects.toThrow(
				"Unknown held action: 9",
			);
		} finally {
			watch.socket.destroy();
			await host.close();
		}
	});

	it("runs one of two calls of an approved command that read the held actions together, and holds the other", async () => {
		const harness = await openDurableHost(join(await mkdtemp(join(root, "gate-race-")), "store.sqlite"), []);
		const push = "git push origin main";

		try {
			const sam = await harness.commit((tx) => addPerson(tx, { name: "Sam" }), BACKGROUND_CONTEXT);

			const thread = await harness.commit(
				(tx) => addThread(tx, { topic: "Rules", persons: [sam.id] }),
				BACKGROUND_CONTEXT,
			);

			const log = { thread: thread.id, from: "user", direction: "in", text: "The rules." } as const;
			const source = await harness.commit((tx) => logMessage(tx, log, "cli"), BACKGROUND_CONTEXT);
			const fields = { name: "go", kind: "conduct", value: "Push only with a go.", status: "decided" } as const;

			const rule = await harness.commit(
				(tx) => setRule(tx, { ...fields, saidBy: "user", source: source.id }, "cli"),
				BACKGROUND_CONTEXT,
			);

			const call = { agent: "khan", tool: "bash", command: push, rule: rule.id, reason: "No go." };
			const held = await harness.commit((tx) => holdAction(tx, { ...call, requestId: "call-1" }), BACKGROUND_CONTEXT);
			await harness.commit((tx) => approveHeld(tx, held.id, "user"), BACKGROUND_CONTEXT);
			conduct = [String(rule.id)];
			recorded.set(push, { writes: 0.98, rule: String(rule.id) });

			// The first commit of each call waits for the other, so both calls read the approval before either runs it.
			const both = Promise.withResolvers<void>();
			let commits = 0;

			const raced: GateHost["harness"] = {
				snapshot: harness.snapshot.bind(harness),
				commit: async (change, context, options) => {
					commits += 1;

					if (commits === 2) both.resolve();

					if (commits <= 2) await both.promise;

					return harness.commit(change, context, options);
				},
			};

			const host: GateHost = {
				harness: raced,
				settings: SettingsManager.inMemory(),
				models,
				signal: new AbortController().signal,
			};

			const gated = (requestId: string) =>
				gateCall(
					{ type: "gate", requestId, caller: "khan", tool: "bash", arguments: { command: push }, messages: [] },
					host,
				);

			const replies = await Promise.all([gated("call-2"), gated("call-3")]);

			expect(replies.filter((reply) => reply.runs)).toHaveLength(1);
			expect(replies.flatMap((reply) => (reply.runs ? [] : [reply.held]))).toEqual([
				expect.objectContaining({ id: 2, state: "held", rule: rule.id }),
			]);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("refuses a held call of a hosted agent with its reason, and tells the agent of an approval, whose command then runs once", async () => {
		const host = await startHost();
		const command = "echo gated";
		const approval = `The user approved held action 1: ${command}. Call it again: it runs one time with no question.`;

		try {
			const source = await sourceMessage(MAIN_PROJECT);

			const rule = await addRule(MAIN_PROJECT, source, {
				name: "echo",
				kind: "conduct",
				value: "Ask before you echo.",
				status: "decided",
			});

			conduct = [String(rule.id)];
			recorded.set(command, { writes: 0.98, rule: String(rule.id) });
			const reason = `It breaks rule ${rule.id} echo: Ask before you echo.`;
			const bash = { name: "bash", arguments: { command } };
			scripts.set("Gate me", [bash]);
			scripts.set(approval, [bash, bash]);
			await agentTurn("Gate me");
			const [refused] = cellResults.get("Gate me") ?? [];
			expect(refused).toContain(`Held as action 1: ${reason}`);
			expect(refused).not.toContain("\ngated");
			// Step 2 has the last messages of the user in the conversation of the agent.
			expect(asked.at(-1)?.context.state).toMatchObject({ action: command, last_user_messages: ["Gate me"] });

			const held = await send({ type: "held", action: "approve", caller: "user", id: 1 });
			expect(held).toMatchObject({ id: 1, state: "approved", agent: expect.stringMatching(/^\d+$/) });
			await until(() => cellResults.get(approval)?.length === 2);
			const [ran, again] = cellResults.get(approval) ?? [];
			expect(ran).toContain("gated");
			expect(ran).not.toContain("Held");
			expect(again).toContain(`Held as action 2: ${reason}`);
			expect(asked.at(-1)?.context.state).toMatchObject({ last_user_messages: ["Gate me", approval] });
		} finally {
			await host?.close();
		}
	});
});
