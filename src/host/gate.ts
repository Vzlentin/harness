/**
 * The gate on the tool calls of the agents: it checks a call that can write against the decided conduct rules of the
 * project, in two questions to the classifier of `gateClassifier`, and holds a call that breaks one.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ClassifierApi, ClassifierChoiceAnswer, ClassifierModel, ClassifierQuestion } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type Cursor,
	defineExtension,
	type Extension,
	type Harness,
	type HookApi,
	hook,
	ToolTask,
	UserEntry,
} from "@earendil-works/pi-durable";
import { asksNoQuestion, GATE_MESSAGES, type GateReply, gateCommand, heldText, userText } from "../protocol/gate.ts";
import type { HeldInput, Rule } from "../protocol/project.ts";
import { errorMessage, type Request } from "../protocol/requests.ts";
import type { Send } from "../tool.ts";
import { answerOf, askClassifier, classifierFailed, classifierModel } from "./classify.ts";
import { heldFor, holdAction, readHeld, readRules, runApproved, runsFor } from "./project.ts";

const context = BACKGROUND_CONTEXT;

/** The number of entries that one page of the read of the user messages gives. */
const PAGE = 50;

/** A probability of `writes` above which the call goes to the question of the rules. */
const WRITES_ABOVE = 0.5;

const RUNS: GateReply = { runs: true };

const NO_ABORT = new AbortController().signal;

/** Step 1: whether the command can write outside the machine or change a decided rule. */
const WRITES: ClassifierQuestion = {
	type: "bool",
	instructions:
		"Does this command write to a system outside this machine that other people see or use (send, post, merge, deploy, trigger, push, update a shared document or ticket), or change a decided rule?",
	criteria: {
		true: "It writes outside or changes a rule.",
		false: "It only reads, or changes local files only.",
	},
};

/** What the gate uses of the host. */
export type GateHost = {
	readonly harness: Pick<Harness, "snapshot" | "commit">;
	/** Pi's settings, for `gateClassifier`. */
	readonly settings: SettingsManager;
	readonly models: Models;
	readonly signal: AbortSignal;
};

/** Why the gate holds a call: the rule that it breaks, or no rule when the gate failed. */
type Hold = Pick<HeldInput, "rule" | "reason">;

/**
 * The reply of the gate to `request`, in this order. A read runs. An approved action of the same agent, tool and command
 * that ran for no call, or for this call, runs, and is marked as run by this call. A held or dropped action of the same
 * agent and request ID is given again. With no decided conduct rule, the call runs. Otherwise the classifier answers
 * step 1 with the command, and step 2 with the command, the messages and the rules, and a call that breaks a rule is
 * held with it. A failure of the classifier holds the call with no rule and the error as the reason.
 */
export async function gateCall(request: Extract<Request, { type: "gate" }>, host: GateHost): Promise<GateReply> {
	const { harness } = host;

	if (asksNoQuestion(request.tool, request.arguments)) return RUNS;
	const command = gateCommand(request.tool, request.arguments);
	const { requestId, caller: agent, tool } = request;
	const { held } = await readHeld(harness, context);
	const call = { agent, tool, command, requestId };

	const candidate = held.some((found) => runsFor(found, call));

	if (candidate && (await harness.commit((tx) => runApproved(tx, call), context)) !== undefined) return RUNS;

	const again = heldFor(held, agent, requestId);

	if (again !== undefined) return { runs: false, held: again };
	const { rules } = await readRules(harness, { kind: "conduct", status: "decided" }, context);

	if (rules.length === 0) return RUNS;

	const hold = await brokenRule(host, command, request.messages, rules).catch((cause: unknown) => ({
		reason: errorMessage(cause),
	}));

	if (hold === undefined) return RUNS;
	const input: HeldInput = { requestId, agent, tool, command, ...hold };

	return { runs: false, held: await harness.commit((tx) => holdAction(tx, input), context) };
}

/** The rule of `rules` that the command breaks, as the classifier answers the two steps, or none. */
async function brokenRule(
	host: GateHost,
	command: string,
	messages: readonly string[],
	rules: readonly Rule[],
): Promise<Hold | undefined> {
	const { models, signal } = host;
	const model = await classifierModel(host.settings, models, "gateClassifier");
	const first = await askClassifier(models, model, { state: { command }, questions: { writes: WRITES } }, signal);
	const writes = answerOf(model, first, "writes", "bool");

	if (writes.probability <= WRITES_ABOVE) return undefined;
	const state = { action: command, last_user_messages: [...messages] };
	const second = await askClassifier(models, model, { state, questions: { rule: ruleQuestion(rules) } }, signal);

	return ruleOf(model, answerOf(model, second, "rule", "choice"), rules);
}

/** The rule of the choice `answer` of `model`, or none for `none`. */
function ruleOf(
	model: ClassifierModel<ClassifierApi>,
	answer: ClassifierChoiceAnswer,
	rules: readonly Rule[],
): Hold | undefined {
	if (answer.choice === "none") return undefined;
	const rule = rules.find((found) => String(found.id) === answer.choice);

	if (rule === undefined) throw new Error(`${classifierFailed(model)}: no rule ${answer.choice}`);

	return { rule: rule.id, reason: `It breaks rule ${rule.id} ${rule.name}: ${rule.value}` };
}

/** Step 2: the rule of `rules` that the action breaks, as one choice, or `none`. */
function ruleQuestion(rules: readonly Rule[]): ClassifierQuestion {
	const criteria = Object.fromEntries(rules.map((rule) => [String(rule.id), `${rule.name}: ${rule.value}`]));

	return {
		type: "choice",
		instructions:
			"Which rule does the action break most clearly, given what the user said in `last_user_messages`? A rule that needs the user's go is broken when the messages give no go for this exact action.",
		criteria: { none: "The action breaks no rule.", ...criteria },
	};
}

/**
 * The pi-durable extension of the gate: before each tool call of a hosted agent, it sends `gate` with the last messages
 * of the user in the conversation, and refuses a held call with its reason. A call of a read tool asks nothing. A
 * request that fails refuses the call with its error. The request ID is the ID of the tool task, so a hook that runs
 * again after a restart gets the same reply.
 */
export function gateExtension(send: Send): Extension {
	const gate = hook(ToolTask, {
		beforeTool: async (call, api, hookContext) => {
			if (asksNoQuestion(call.name, call.arguments)) return undefined;

			try {
				const reply = await send(
					{
						type: "gate",
						requestId: `gate:${api.taskId}`,
						caller: String(api.conversationId),
						tool: call.name,
						arguments: call.arguments,
						messages: await userMessages(api, hookContext),
					},
					hookContext.abortSignal ?? NO_ABORT,
				);

				return reply.runs ? undefined : { block: heldText(reply.held) };
			} catch (cause) {
				return { block: errorMessage(cause) };
			}
		},
	});

	return defineExtension({ name: "harness-gate", hooks: [gate] });
}

/** The texts of the last user messages of the conversation of `api`, at most `GATE_MESSAGES`, oldest first. */
async function userMessages(api: HookApi, hookContext: Context): Promise<string[]> {
	const texts: string[] = [];
	let cursor: Cursor | undefined;

	do {
		const page = await api.entries({}, PAGE, cursor, hookContext);

		for (const entry of page.items) {
			const message = UserEntry.is(entry) ? entry.model?.[0] : undefined;

			if (message?.role === "user") texts.push(userText(message.content));

			if (texts.length === GATE_MESSAGES) return texts.reverse();
		}

		cursor = page.next;
	} while (cursor !== undefined);

	return texts.reverse();
}
