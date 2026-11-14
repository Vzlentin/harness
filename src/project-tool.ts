import type { JsonValue } from "@earendil-works/chord/json";
/**
 * The tools of the store of the project, `thread`, `rule`, `term`, `part` and `parley`: their descriptions, their
 * schemas and their runners, which the host and the Pi extension register.
 */
import type * as Durable from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type * as TypeBox from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	Ask,
	ASK_KINDS,
	AskList,
	askLine,
	AskWrite,
	type Author,
	MESSAGE_MARKS,
	MESSAGE_STATES,
	Message,
	messageLine,
	Part,
	PART_KINDS,
	PartList,
	partLine,
	Parley,
	ParleyAsks,
	type ParleyFrame,
	ParleyList,
	parleyLine,
	parleyText,
	PersonList,
	type PersonNames,
	personNames,
	Rule,
	RULE_KINDS,
	RULE_STATES,
	RuleList,
	ruleLine,
	Term,
	TermList,
	termLine,
	ThreadList,
	threadLine,
	ThreadMessages,
} from "./protocol/project.ts";
import type { Request } from "./protocol/requests.ts";
import { type DurableScope, listText, NO_ABORT, oneOf, required, type ToolScope } from "./tool.ts";

export const THREAD_TOOL_DESCRIPTION = `Read and write the threads of messages between the user and the persons of the project.
- list: the threads, each as \`<id> <topic> with <persons>: <time of the last message>\`.
- read: the thread \`thread\` and its messages, oldest first, each as \`<id> <time> <author> (<state>): <text>\`, where the state is ${oneOf(MESSAGE_STATES)}. The ID of a message is the \`source\` of a rule or a term.
- log: add a message that the person \`from\` wrote in the thread \`thread\`, with \`text\`, and \`at\` when you know it. It moves each earlier draft of the thread to sent, and each sent message to answered.
- draft: add a draft of the user to the persons of the thread \`thread\`, with \`text\`. It sends nothing.
- mark: set the state of the draft or sent message \`message\` to \`state\`: sent when the user sent it, draft when it was not sent, dropped when it will not go.
When you send a draft yourself, put \`draft:<id>\` in the command, such as the shell comment \`# draft:12\`: the draft is sent once the call runs.
A person prints as \`<name> (<id>)\`: its ID is the \`from\` of \`log\`, and the \`saidBy\` of a rule or a term.`;

export const RULE_TOOL_DESCRIPTION = `Keep the rules of the project. A conduct rule says how to act. A domain rule says what is true for the project.
- set: without \`id\`, add a rule with \`name\`, \`kind\`, \`value\`, and \`status\` (default open); \`replaces\` retires the rule that it replaces. With \`id\`, change the fields that you give. Each set needs \`saidBy\`, the ID of the person who said it or user, and \`source\`, the ID of the message that says it (see the \`thread\` tool).
- list: the rules, only those of \`kind\` and of \`status\` when you give them.
Each rule prints as \`<id> <name> (<kind>, <status>): <value> [said by <author> in message <source>]\`, where the author is \`user\` or \`<name> (<id>)\`.`;

export const TERM_TOOL_DESCRIPTION = `Keep the terms of the project: a word, its meaning, and the words not to use for it.
- set: without \`id\`, add a term with \`name\`, \`meaning\` and \`avoid\`. With \`id\`, change the fields that you give. Each set needs \`saidBy\` and \`source\`, as a rule does.
- list: the terms.
Each term prints as \`<id> <name>: <meaning> [avoid <words>; said by <author> in message <source>]\`.`;

export const PART_TOOL_DESCRIPTION = `Keep the parts of the vault: the files that explain rules and terms. A part becomes stale when one of its rules or terms changes.
- add: add a part of \`kind\` at \`path\`, its file in the vault, that explains the rules \`rules\` and the terms \`terms\`.
- list: the parts, only those that explain the rule \`rule\` when you give it.
Each part prints as \`<id> <kind> <path> [rules <ids>; terms <ids>; checked <time>]\`, with \`stale\` at the end when it is stale.`;

export const PARLEY_TOOL_DESCRIPTION = `Put questions to the user as asks, alone or in a parley: a group of asks with a slug, a title, a goal, evidence and a design sense.
- round: add the asks \`asks\`. With \`slug\`, they serve the parley \`slug\`: a new slug needs \`title\` and \`goal\`, and \`title\`, \`goal\`, \`evidence\` and \`design_sense\` change an open parley.
- answer: write the answers of the user, \`answers\`, each to the ask \`ask\`: the key of an option, ok, or own with the \`label\` that the user gave it, and \`words\`, the exact words of the user. The answer ok to the read-back of a parley, its ask with no options, makes the parley a contract.
- drop: drop the open ask \`ask\`.
- take: become the asker of the open asks of the parley \`slug\`, open or a contract. It gives the answers that waited for the asker.
- end: end the contract \`slug\` with \`status\`: done or dropped.
- read: the parley \`slug\` and its asks, or the ask \`ask\` and its view.
- list: the parleys, then the open asks with no parley.
With \`slug\`, \`ask\` is the number of the ask in the parley. Without \`slug\`, it is the ID of an ask with no parley.
The user answers a parley with a line such as \`[<slug>] 1a 3:"own words" 4b:"a note" ?5 ok\`. Write it with one \`answer\` call with \`slug\`:
- \`<n><key>\` is \`{ ask: n, answer: key }\`, and \`<n><key>:"<words>"\` adds \`words: [<words>]\`.
- \`<n>:"<words>"\` is \`{ ask: n, answer: own, label, words: [<words>] }\`, with a short label of the words.
- \`?<n>\` writes nothing: explain n first.
- \`ok\` is \`{ ask: n, answer: <plan> }\` for each open my call n that the line does not name, and \`{ ask: n, answer: ok }\` for the open read-back n.
A parley prints as \`<slug> · <status> · <title>\`, then each ask as \`<n> · <title> · <kind> · open · plan <key> · <label>\`, \`<n> · <title> · <kind> · <answer> · <label>\` or \`<n> · <title> · <kind> · dropped\`. Its last line is the answer line of an open parley, \`[<slug>]\` with \`<n><plan>\` for each open your call and ok, or \`harness parley show <slug>\`.`;

/**
 * The parameters and the output schemas of the tools of the store of the project, built with the caller's TypeBox
 * `Type`, as in `toolSchemas`. The outputs hold the protocol schemas of the objects, which are plain JSON schemas.
 */
export function projectToolSchemas(typebox: Pick<typeof TypeBox, "Type">) {
	const { Type } = typebox;
	const id = (description: string) => Type.Optional(Type.Integer({ minimum: 1, description }));
	const ids = (description: string) => Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description }));
	const text = (description: string) => Type.Optional(Type.String({ pattern: "\\S", description }));

	const provenance = {
		saidBy: Type.Optional(
			Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("user")], {
				description: "set: who said it: the ID of a person, or user",
			}),
		),
		source: id("set: the ID of the message that says it"),
	};

	const thread = {
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("list"), Type.Literal("read"), Type.Literal("log"), Type.Literal("draft"), Type.Literal("mark")],
				{ description: "What to do" },
			),
			thread: id("read, log, draft: the ID of the thread"),
			from: id("log: the ID of the person who wrote the message"),
			text: text("log, draft: the text of the message"),
			at: Type.Optional(
				Type.Integer({ minimum: 0, description: "log: when the person wrote it, in epoch milliseconds; default now" }),
			),
			message: id("mark: the ID of the message"),
			state: Type.Optional(Type.Enum(MESSAGE_MARKS, { description: `mark: ${oneOf(MESSAGE_MARKS)}` })),
		}),
		output: Type.Union([
			Type.Object({ action: Type.Literal("list"), value: ThreadList }),
			Type.Object({ action: Type.Literal("read"), value: ThreadMessages }),
			Type.Object({
				action: Type.Union([Type.Literal("log"), Type.Literal("draft"), Type.Literal("mark")]),
				value: Message,
			}),
		]),
	};

	const rule = {
		parameters: Type.Object({
			action: Type.Union([Type.Literal("set"), Type.Literal("list")], { description: "What to do" }),
			id: id("set: the ID of the rule to change; without it, set adds a rule"),
			name: text("set: the name of the rule"),
			kind: Type.Optional(
				Type.Enum(RULE_KINDS, { description: `set: ${oneOf(RULE_KINDS)}; list: only the rules of this kind` }),
			),
			value: text("set: what the rule says"),
			status: Type.Optional(
				Type.Enum(RULE_STATES, {
					description: `set: ${oneOf(RULE_STATES)}, default open for a new rule; list: only the rules with this status`,
				}),
			),
			...provenance,
			replaces: id("set: on a new rule, the ID of the rule that it replaces and retires"),
		}),
		output: Type.Union([
			Type.Object({ action: Type.Literal("set"), value: Rule }),
			Type.Object({ action: Type.Literal("list"), value: RuleList }),
		]),
	};

	const term = {
		parameters: Type.Object({
			action: Type.Union([Type.Literal("set"), Type.Literal("list")], { description: "What to do" }),
			id: id("set: the ID of the term to change; without it, set adds a term"),
			name: text("set: the word"),
			meaning: text("set: what the word means in the project"),
			avoid: Type.Optional(
				Type.Array(Type.String({ pattern: "\\S" }), { description: "set: the words not to use for it" }),
			),
			...provenance,
		}),
		output: Type.Union([
			Type.Object({ action: Type.Literal("set"), value: Term }),
			Type.Object({ action: Type.Literal("list"), value: TermList }),
		]),
	};

	const part = {
		parameters: Type.Object({
			action: Type.Union([Type.Literal("add"), Type.Literal("list")], { description: "What to do" }),
			kind: Type.Optional(Type.Enum(PART_KINDS, { description: `add: ${oneOf(PART_KINDS)}` })),
			path: text("add: the file of the part in the vault"),
			rules: ids("add: the IDs of the rules that it explains; default none"),
			terms: ids("add: the IDs of the terms that it explains; default none"),
			rule: id("list: only the parts that explain this rule"),
		}),
		output: Type.Union([
			Type.Object({ action: Type.Literal("add"), value: Part }),
			Type.Object({ action: Type.Literal("list"), value: PartList }),
		]),
	};

	const parley = {
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("round"),
					Type.Literal("answer"),
					Type.Literal("drop"),
					Type.Literal("take"),
					Type.Literal("end"),
					Type.Literal("read"),
					Type.Literal("list"),
				],
				{ description: "What to do" },
			),
			slug: text("round, answer, drop, read: the parley of the asks; take, end: the parley"),
			title: text("round: the title of the parley"),
			goal: text("round: the goal of the parley"),
			evidence: Type.Optional(
				Type.Array(Type.String({ pattern: "\\S" }), { description: "round: the evidence of the parley" }),
			),
			design_sense: text("round: the design sense of the parley, which its contract needs"),
			asks: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ pattern: "\\S" }),
						kind: Type.Optional(Type.Enum(ASK_KINDS)),
						tension: Type.Optional(Type.String()),
						options: Type.Optional(
							Type.Array(
								Type.Object({
									key: Type.String({ description: "One lowercase letter" }),
									label: Type.String(),
									gains: Type.Optional(Type.Array(Type.String())),
									costs: Type.Optional(Type.Array(Type.String())),
								}),
							),
						),
						plan: Type.Optional(Type.String({ description: "The key of the option that you propose" })),
						view: Type.Optional(Type.String({ description: "A text that explains the ask, in Markdown" })),
					}),
					{ description: "round: the asks; an ask with no options in a parley is its read-back" },
				),
			),
			answers: Type.Optional(
				Type.Array(
					Type.Object({
						ask: Type.Integer({ minimum: 1 }),
						answer: Type.String({ description: "The key of an option, ok, or own" }),
						label: Type.Optional(Type.String({ description: "The label of the answer, which own needs" })),
						words: Type.Optional(Type.Array(Type.String(), { description: "The exact words of the user" })),
					}),
					{ description: "answer: the answers, each of another ask" },
				),
			),
			ask: id("drop, read: the ask, its number with slug, else its ID"),
			status: Type.Optional(
				Type.Union([Type.Literal("done"), Type.Literal("dropped")], { description: "end: done or dropped" }),
			),
		}),
		output: Type.Union([
			Type.Object({
				action: Type.Union([Type.Literal("round"), Type.Literal("answer"), Type.Literal("drop")]),
				value: AskWrite,
			}),
			Type.Object({ action: Type.Literal("take"), value: ParleyAsks }),
			Type.Object({ action: Type.Literal("end"), value: Parley }),
			Type.Object({ action: Type.Literal("read"), value: Type.Union([ParleyAsks, Ask]) }),
			Type.Object({
				action: Type.Literal("list"),
				value: Type.Object({ ...ParleyList.properties, ...AskList.properties }),
			}),
		]),
	};

	return { thread, rule, term, part, parley };
}

type ProjectSchemas = ReturnType<typeof projectToolSchemas>;

/** What a call of a tool of the store of the project gets from its adapter. The store keeps the caller of each write. */
type ProjectScope = Pick<ToolScope, "caller" | "send" | "signal">;

/** A tool of the store of the project, as the host and the Pi extension register it. */
export type ProjectTool<P extends TSchema, O extends TSchema> = {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: P;
	readonly output: O;
	readonly run: (args: Static<P>, scope: ProjectScope) => Promise<{ readonly text: string; readonly data: JsonValue }>;
};

/** Registers one tool of the store of the project, whatever its schemas, and gives what the adapter keeps of it. */
export type ProjectToolAdapter<R> = <P extends TSchema, O extends TSchema>(tool: ProjectTool<P, O>) => R;

/** The tools of the store of the project, `thread`, `rule`, `term`, `part` and `parley`, each given to `adapt`. */
export function projectTools<R>(typebox: Pick<typeof TypeBox, "Type">, adapt: ProjectToolAdapter<R>): R[] {
	const { thread, rule, term, part, parley } = projectToolSchemas(typebox);

	return [
		adapt({ name: "thread", label: "Thread", description: THREAD_TOOL_DESCRIPTION, ...thread, run: runThreadTool }),
		adapt({ name: "rule", label: "Rule", description: RULE_TOOL_DESCRIPTION, ...rule, run: runRuleTool }),
		adapt({ name: "term", label: "Term", description: TERM_TOOL_DESCRIPTION, ...term, run: runTermTool }),
		adapt({ name: "part", label: "Part", description: PART_TOOL_DESCRIPTION, ...part, run: runPartTool }),
		adapt({ name: "parley", label: "Parley", description: PARLEY_TOOL_DESCRIPTION, ...parley, run: runParleyTool }),
	];
}

/** `reply` as `schema`, the reply that the request expects. It throws when the host replied with another object. */
function replyOf<T extends TSchema, R extends object>(schema: T, reply: R, expected: string): R & Static<T> {
	if (!Value.Check(schema, reply)) throw new Error(`The host replied with no ${expected}`);

	return reply;
}

/** The names of the persons of the project, by ID, from a `person list` request. */
async function sendPersonNames(scope: ProjectScope, signal: AbortSignal): Promise<PersonNames> {
	return personNames(replyOf(PersonList, await scope.send({ type: "person", action: "list" }, signal), "persons"));
}

/**
 * The fields of a `set` of a rule or a term: its author and its source, which each set needs, then the fields of a new
 * one from `fresh` without `id`, or the change with `id`.
 */
function setFields<A extends { id?: number; saidBy?: Author; source?: number }, F extends object>(
	args: A,
	fresh: () => F,
) {
	const { id, ...fields } = args;

	const said = {
		...fields,
		saidBy: required(args.saidBy, "saidBy", "set"),
		source: required(args.source, "source", "set"),
	};

	return id === undefined ? { ...said, ...fresh() } : { ...said, id };
}

async function runThreadTool(args: Static<ProjectSchemas["thread"]["parameters"]>, scope: ProjectScope) {
	const { action } = args;
	const signal = scope.signal ?? NO_ABORT;

	switch (action) {
		case "list": {
			const reply = replyOf(ThreadList, await scope.send({ type: "thread", action }, signal), "list of threads");
			const names = await sendPersonNames(scope, signal);

			return {
				text: listText(reply.threads, (thread) => threadLine(thread, names), "No threads"),
				data: { action, value: reply },
			};
		}

		case "read": {
			const id = required(args.thread, "thread", action);
			const reply = replyOf(ThreadMessages, await scope.send({ type: "thread", action, id }, signal), "messages");
			const names = await sendPersonNames(scope, signal);
			const messages = listText(reply.messages, (message) => messageLine(message, names), "No messages");

			return { text: `${threadLine(reply.thread, names)}\n${messages}`, data: { action, value: reply } };
		}

		case "log":
		case "draft": {
			const thread = required(args.thread, "thread", action);

			const { at, ...sender } =
				action === "log"
					? { from: required(args.from, "from", action), direction: "in" as const, at: args.at }
					: { from: "user" as const, direction: "out" as const, at: undefined };

			const log = {
				type: "message",
				action: "log",
				caller: scope.caller,
				thread,
				...sender,
				text: required(args.text, "text", action),
			} as const;

			const names = await sendPersonNames(scope, signal);
			const message = await scope.send(at === undefined ? log : { ...log, at }, signal);

			return { text: `${messageLine(message, names)}\n`, data: { action, value: message } };
		}

		case "mark": {
			const mark = {
				type: "message",
				action,
				caller: scope.caller,
				message: required(args.message, "message", action),
				state: required(args.state, "state", action),
			} as const;

			const names = await sendPersonNames(scope, signal);
			const message = await scope.send(mark, signal);

			return { text: `${messageLine(message, names)}\n`, data: { action, value: message } };
		}

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

async function runRuleTool(args: Static<ProjectSchemas["rule"]["parameters"]>, scope: ProjectScope) {
	const { action } = args;
	const signal = scope.signal ?? NO_ABORT;

	switch (action) {
		case "set": {
			const fields = setFields(args, () => ({
				name: required(args.name, "name", action),
				kind: required(args.kind, "kind", action),
				value: required(args.value, "value", action),
			}));

			const names = await sendPersonNames(scope, signal);

			const rule = replyOf(
				Rule,
				await scope.send({ ...fields, type: "rule", action, caller: scope.caller }, signal),
				"rule",
			);

			return { text: `${ruleLine(rule, names)}\n`, data: { action, value: rule } };
		}

		case "list": {
			let request: Extract<Request, { type: "rule"; action: "list" }> = { type: "rule", action };

			if (args.kind !== undefined) request = { ...request, kind: args.kind };

			if (args.status !== undefined) request = { ...request, status: args.status };
			const reply = replyOf(RuleList, await scope.send(request, signal), "list of rules");
			const names = await sendPersonNames(scope, signal);

			return {
				text: listText(reply.rules, (rule) => ruleLine(rule, names), "No rules"),
				data: { action, value: reply },
			};
		}

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

async function runTermTool(args: Static<ProjectSchemas["term"]["parameters"]>, scope: ProjectScope) {
	const { action } = args;
	const signal = scope.signal ?? NO_ABORT;

	switch (action) {
		case "set": {
			const fields = setFields(args, () => ({
				name: required(args.name, "name", action),
				meaning: required(args.meaning, "meaning", action),
			}));

			const names = await sendPersonNames(scope, signal);

			const term = replyOf(
				Term,
				await scope.send({ ...fields, type: "term", action, caller: scope.caller }, signal),
				"term",
			);

			return { text: `${termLine(term, names)}\n`, data: { action, value: term } };
		}

		case "list": {
			const reply = replyOf(TermList, await scope.send({ type: "term", action }, signal), "list of terms");
			const names = await sendPersonNames(scope, signal);

			return {
				text: listText(reply.terms, (term) => termLine(term, names), "No terms"),
				data: { action, value: reply },
			};
		}

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

async function runPartTool(args: Static<ProjectSchemas["part"]["parameters"]>, scope: ProjectScope) {
	const { action } = args;
	const signal = scope.signal ?? NO_ABORT;

	switch (action) {
		case "add": {
			const add = {
				type: "part",
				action,
				caller: scope.caller,
				kind: required(args.kind, "kind", action),
				path: required(args.path, "path", action),
				rules: args.rules ?? [],
				terms: args.terms ?? [],
			} as const;

			const part = replyOf(Part, await scope.send(add, signal), "part");

			return { text: `${partLine(part)}\n`, data: { action, value: part } };
		}

		case "list": {
			const list = { type: "part", action } as const;
			const request = args.rule === undefined ? list : { ...list, rule: args.rule };
			const reply = replyOf(PartList, await scope.send(request, signal), "list of parts");

			return { text: listText(reply.parts, partLine, "No parts"), data: { action, value: reply } };
		}

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

type ParleyArgs = Static<ProjectSchemas["parley"]["parameters"]>;

/** The ask `n` of a call: its number in the parley `slug`, or its ID without `slug`. */
function askRef(slug: string | undefined, n: number) {
	return slug === undefined ? { id: n } : { slug, n };
}

/** The text of a write: the text of each parley that it changed, then the line of each ask with no parley. */
function writeText(write: AskWrite): string {
	return write.parleys.map(parleyText).join("") + write.asks.map((ask) => `${askLine(ask)}\n`).join("");
}

/** The frame of the parley of a round: its slug and the fields that the call gives. */
function roundFrame(args: ParleyArgs): ParleyFrame | undefined {
	const { slug, title, goal, evidence, design_sense } = args;

	if (slug === undefined) {
		if ([title, goal, evidence, design_sense].some((field) => field !== undefined))
			throw new Error("round requires slug");

		return undefined;
	}

	let frame: ParleyFrame = { slug };

	if (title !== undefined) frame = { ...frame, title };

	if (goal !== undefined) frame = { ...frame, goal };

	if (evidence !== undefined) frame = { ...frame, evidence };

	if (design_sense !== undefined) frame = { ...frame, design_sense };

	return frame;
}

/** The answers of an `ask answer` request, built field by field, each naming its ask in the parley `slug`, or by ID. */
function answerInputs(answers: NonNullable<ParleyArgs["answers"]>, slug: string | undefined) {
	return answers.map((answer) => {
		const base = { ...askRef(slug, answer.ask), answer: answer.answer };
		const labeled = answer.label === undefined ? base : { ...base, label: answer.label };

		return answer.words === undefined ? labeled : { ...labeled, words: answer.words };
	});
}

async function runParleyTool(args: ParleyArgs, scope: ProjectScope) {
	const { action, slug } = args;
	const signal = scope.signal ?? NO_ABORT;
	const caller = scope.caller;

	switch (action) {
		case "round": {
			if (args.asks === undefined) throw new Error(`${action} requires asks`);
			const frame = roundFrame(args);
			const round = { type: "ask", action, caller, asks: args.asks } as const;
			const request = frame === undefined ? round : { ...round, parley: frame };
			const reply = replyOf(AskWrite, await scope.send(request, signal), "write of asks");

			return { text: writeText(reply), data: { action, value: reply } };
		}

		case "answer": {
			if (args.answers === undefined) throw new Error(`${action} requires answers`);
			const answers = answerInputs(args.answers, slug);
			const request = { type: "ask", action, caller, answers } as const;
			const reply = replyOf(AskWrite, await scope.send(request, signal), "write of asks");

			return { text: writeText(reply), data: { action, value: reply } };
		}

		case "drop": {
			const request = { type: "ask", action, caller, ...askRef(slug, required(args.ask, "ask", action)) } as const;
			const reply = replyOf(AskWrite, await scope.send(request, signal), "write of asks");

			return { text: writeText(reply), data: { action, value: reply } };
		}

		case "take": {
			const request = { type: "parley", action, caller, slug: required(slug, "slug", action) } as const;
			const reply = replyOf(ParleyAsks, await scope.send(request, signal), "parley");

			return { text: parleyText(reply), data: { action, value: reply } };
		}

		case "end": {
			const request = {
				type: "parley",
				action,
				caller,
				slug: required(slug, "slug", action),
				status: required(args.status, "status", action),
			} as const;

			const parley = replyOf(Parley, await scope.send(request, signal), "parley");

			return { text: `${parleyLine(parley)}\n`, data: { action, value: parley } };
		}

		case "read": {
			if (slug !== undefined && args.ask === undefined) {
				const request = { type: "parley", action, slug } as const;
				const reply = replyOf(ParleyAsks, await scope.send(request, signal), "parley");

				return { text: parleyText(reply), data: { action, value: reply } };
			}

			const request = { type: "ask", action, ...askRef(slug, required(args.ask, "ask", action)) } as const;
			const ask = replyOf(Ask, await scope.send(request, signal), "ask");
			const view = ask.view === undefined ? "" : `${ask.view}\n`;

			return { text: `${askLine(ask)}\n${view}`, data: { action, value: ask } };
		}

		case "list": {
			const parleys = replyOf(ParleyList, await scope.send({ type: "parley", action }, signal), "list of parleys");
			const open = replyOf(AskList, await scope.send({ type: "ask", action }, signal), "list of asks");
			const asks = open.asks.filter((ask) => ask.parley === undefined);

			const text =
				listText(parleys.parleys, parleyLine, "No parleys") + asks.map((ask) => `${askLine(ask)}\n`).join("");

			return { text, data: { action, value: { parleys: parleys.parleys, asks } } };
		}

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

/**
 * The pi-durable extension with the tools of the store of the project. Their requests have no request ID, so a call
 * that a restart interrupts does not run again: a message is never logged twice.
 */
export function projectToolsExtension(
	durable: typeof Durable,
	typebox: Pick<typeof TypeBox, "Type">,
	scope: Pick<DurableScope, "caller" | "send">,
): Extension {
	const tools = projectTools(typebox, (tool) =>
		durable.defineTool({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			structuredOutputSchema: tool.output,
			replay: "unsafe",
			async execute(args, api, context) {
				// pi-durable has validated the arguments, but its types do not narrow TypeBox schemas.
				if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid ${tool.name} arguments`);
				const caller = await scope.caller(api, context);
				const { text, data } = await tool.run(args, { caller, send: scope.send, signal: context.abortSignal });

				return { output: [{ type: "text", text }], structuredOutput: data };
			},
		}),
	);

	return durable.defineExtension({ name: "harness-project", tools });
}
