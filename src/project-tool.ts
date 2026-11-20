import type { JsonValue } from "@earendil-works/chord/json";
/**
 * The tools of the store of the project, `thread`, `rule`, `parley` and `item`: their descriptions, their schemas and
 * their runners, which the host and the Pi extension register.
 */
import type * as Durable from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type * as TypeBox from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	EDGE_KINDS,
	Edge,
	edgeLine,
	ITEM_MARKS,
	ITEM_STAGES,
	ITEM_STATES,
	ItemList,
	itemLine,
	itemText,
	NEEDS_YOU_MARK,
	Ref,
	StagedItem,
} from "./protocol/item.ts";
import {
	Ask,
	ASK_KINDS,
	AskList,
	askLine,
	AskWrite,
	MESSAGE_MARKS,
	MESSAGE_STATES,
	Message,
	messageLine,
	Parley,
	ParleyAsks,
	type ParleyFrame,
	ParleyList,
	parleyLine,
	parleyText,
	PersonList,
	type PersonNames,
	PROJECT_EXTENSION,
	personNames,
	Rule,
	RULE_KINDS,
	RULE_STATES,
	type RuleFilter,
	RuleList,
	type RuleUserChange,
	ruleLine,
	ThreadList,
	threadLine,
	ThreadMessages,
} from "./protocol/project.ts";
import type { Request } from "./protocol/requests.ts";
import { type DurableScope, listText, NO_ABORT, oneOf, required, type ToolScope } from "./tool.ts";

export const THREAD_TOOL_DESCRIPTION = `Read and write the threads of messages between the user and the persons of the project.
- list: the threads, each as \`<id> <topic> with <persons>: <time of the last message>\`.
- read: the thread \`thread\` and its messages, oldest first, each as \`<id> <time> <author> (<state>): <text>\`, where the state is ${oneOf(MESSAGE_STATES)}. The ID of a message is the \`source\` of a rule.
- log: add a message that the person \`from\` wrote in the thread \`thread\`, with \`text\`, and \`at\` when you know it. It moves each earlier draft of the thread to sent, and each sent message to answered.
- draft: add a draft of the user to the persons of the thread \`thread\`, with \`text\`. It sends nothing.
- mark: set the state of the draft or sent message \`message\` to \`state\`: sent when the user sent it, draft when it was not sent, dropped when it will not go.
When you send a draft yourself, put \`draft:<id>\` in the command, such as the shell comment \`# draft:12\`: the draft is sent once the call runs.
A person prints as \`<name> (<id>)\`: its ID is the \`from\` of \`log\`, and the \`saidBy\` of a rule.`;

export const RULE_TOOL_DESCRIPTION = `Keep the rules of the project. A conduct rule says how to act. A domain rule says what is true for the project. You propose a rule; only the user puts it in effect.
- set: without \`id\`, add an open rule with \`name\`, \`kind\` and \`value\`; \`replaces\` names the rule that it replaces, which is retired when the user decides the new one. With \`id\`, change the fields that you give of an open rule. To change a decided rule, add a new rule that replaces it. Each set needs \`saidBy\`, the ID of the person who said it or user, and \`source\`, the ID of the message that says it (see the \`thread\` tool).
- list: the rules, only those of \`kind\` when you give it.
Each rule prints as \`<id> <name> (<kind>, <status>): <value> [said by <author> in message <source>]\`, where the status is ${oneOf(RULE_STATES)} and the author is \`user\` or \`<name> (<id>)\`. A rule of the user has no source.`;

export const PARLEY_TOOL_DESCRIPTION = `Put questions to the user as asks, alone or in a parley: a group of asks with a slug, a title, a goal, evidence and a design sense.
Before you ask, read the vault on the topic. Write the view of each ask with show-me, with wiki links to the notes that the vault already holds. When the user answers an ask and \`VAULT\` names a folder that exists, you get the todo \`Save to the vault: <title>\`. Ask your next question first, and do the todo while the user decides: write the view and the decision into the vault, with an update of a note that exists when you can. Give the note an \`id\` in its front matter, and record that ID with \`note\` (or \`harness parley note\`): this closes the todo. When nothing is worth a note, set the todo to dropped with the \`todo\` tool, and say why in one line.
- round: add the asks \`asks\`. With \`slug\`, they serve the parley \`slug\`: a new slug needs \`title\` and \`goal\`, and \`title\`, \`goal\`, \`evidence\` and \`design_sense\` change an open parley. With \`item\` and \`slug\`, the parley shapes the open work item \`item\`.
- answer: write the answers of the user, \`answers\`, each to the ask \`ask\`: the key of an option, ok, or own with the \`label\` that the user gave it, and \`words\`, the exact words of the user. The answer ok to the read-back of a parley, its ask with no options, makes the parley a contract.
- drop: drop the open ask \`ask\`.
- note: record \`note\`, the ID of the note in the vault that explains the ask \`ask\`, in any state. Only the asker of the ask records its note, and a second note replaces the first.
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

export const ITEM_TOOL_DESCRIPTION = `Keep the work items of the project. An item is a piece of work: a title, a text that says what to build, and a state, ${oneOf(ITEM_STATES)}. Its edges link it to the parleys that shape it, the agents and runs that serve it, and the commits that landed it.
- add: add an open item with \`title\`, and \`text\` when you give it.
- set: change the \`title\`, the \`text\` or the \`state\` of the item \`id\`.
- list: the items in the state \`state\`, default open, in ID order.
- read: the item \`id\`, its text and its edges.
- link: add the edge \`from\` \`kind\` \`to\`, where \`kind\` is ${oneOf(EDGE_KINDS)}, and one end is \`item:<id>\`. The other end is \`agent:<conversation>\`, \`run:<run ID>\`, \`parley:<slug>\` or \`commit:<sha>\`.
The host works out the stage of each item: ${oneOf(ITEM_STAGES)}.
Each item prints as \`<mark> <id> <stage> <title>\`: ${ITEM_STATES.map((state) => `${ITEM_MARKS[state]} ${state}`).join(", ")}, or \`${NEEDS_YOU_MARK}\` when the item needs the user. Each edge prints as \`<from> <kind> <to>\`.`;

/**
 * The parameters and the output schemas of the tools of the store of the project, built with the caller's TypeBox
 * `Type`, as in `toolSchemas`. The outputs hold the protocol schemas of the objects, which are plain JSON schemas.
 */
export function projectToolSchemas(typebox: Pick<typeof TypeBox, "Type">) {
	const { Type } = typebox;
	const id = (description: string) => Type.Optional(Type.Integer({ minimum: 1, description }));
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
			...provenance,
			replaces: id("set: on a new rule, the ID of the rule that it replaces"),
		}),
		output: Type.Union([
			Type.Object({ action: Type.Literal("set"), value: Rule }),
			Type.Object({ action: Type.Literal("list"), value: RuleList }),
		]),
	};

	const parley = {
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("round"),
					Type.Literal("answer"),
					Type.Literal("drop"),
					Type.Literal("note"),
					Type.Literal("take"),
					Type.Literal("end"),
					Type.Literal("read"),
					Type.Literal("list"),
				],
				{ description: "What to do" },
			),
			slug: text("round, answer, drop, note, read: the parley of the asks; take, end: the parley"),
			title: text("round: the title of the parley"),
			goal: text("round: the goal of the parley"),
			evidence: Type.Optional(
				Type.Array(Type.String({ pattern: "\\S" }), { description: "round: the evidence of the parley" }),
			),
			design_sense: text("round: the design sense of the parley, which its contract needs"),
			item: id("round: the ID of the work item that the parley shapes"),
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
			ask: id("drop, note, read: the ask, its number with slug, else its ID"),
			note: Type.Optional(Type.String({ description: "note: the ID of the note in the vault that explains the ask" })),
			status: Type.Optional(
				Type.Union([Type.Literal("done"), Type.Literal("dropped")], { description: "end: done or dropped" }),
			),
		}),
		output: Type.Union([
			Type.Object({
				action: Type.Union([Type.Literal("round"), Type.Literal("answer"), Type.Literal("drop")]),
				value: AskWrite,
			}),
			Type.Object({ action: Type.Literal("note"), value: Ask }),
			Type.Object({ action: Type.Literal("take"), value: ParleyAsks }),
			Type.Object({ action: Type.Literal("end"), value: Parley }),
			Type.Object({ action: Type.Literal("read"), value: Type.Union([ParleyAsks, Ask]) }),
			Type.Object({
				action: Type.Literal("list"),
				value: Type.Object({ ...ParleyList.properties, ...AskList.properties }),
			}),
		]),
	};

	const item = {
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("add"), Type.Literal("set"), Type.Literal("list"), Type.Literal("read"), Type.Literal("link")],
				{ description: "What to do" },
			),
			id: id("set, read: the ID of the item"),
			title: text("add, set: the title of the item, one line"),
			text: Type.Optional(Type.String({ description: "add, set: what to build, in Markdown" })),
			state: Type.Optional(
				Type.Enum(ITEM_STATES, { description: `set: ${oneOf(ITEM_STATES)}; list: only the items in this state` }),
			),
			from: text("link: the end the edge comes from, such as parley:<slug>"),
			kind: Type.Optional(Type.Enum(EDGE_KINDS, { description: `link: ${oneOf(EDGE_KINDS)}` })),
			to: text("link: the end the edge goes to, such as item:<id>"),
		}),
		output: Type.Union([
			Type.Object({
				action: Type.Union([Type.Literal("add"), Type.Literal("set"), Type.Literal("read")]),
				value: StagedItem,
			}),
			Type.Object({ action: Type.Literal("list"), value: ItemList }),
			Type.Object({ action: Type.Literal("link"), value: Edge }),
		]),
	};

	return { thread, rule, parley, item };
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

/** The tools of the store of the project, `thread`, `rule`, `parley` and `item`, each given to `adapt`. */
export function projectTools<R>(typebox: Pick<typeof TypeBox, "Type">, adapt: ProjectToolAdapter<R>): R[] {
	const { thread, rule, parley, item } = projectToolSchemas(typebox);

	return [
		adapt({ name: "thread", label: "Thread", description: THREAD_TOOL_DESCRIPTION, ...thread, run: runThreadTool }),
		adapt({ name: "rule", label: "Rule", description: RULE_TOOL_DESCRIPTION, ...rule, run: runRuleTool }),
		adapt({ name: "parley", label: "Parley", description: PARLEY_TOOL_DESCRIPTION, ...parley, run: runParleyTool }),
		adapt({ name: "item", label: "Item", description: ITEM_TOOL_DESCRIPTION, ...item, run: runItemTool }),
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
			const { id, ...rest } = args;

			const said = {
				...rest,
				saidBy: required(args.saidBy, "saidBy", action),
				source: required(args.source, "source", action),
			};

			const fields =
				id === undefined
					? {
							...said,
							name: required(args.name, "name", action),
							kind: required(args.kind, "kind", action),
							value: required(args.value, "value", action),
						}
					: { ...said, id };

			const names = await sendPersonNames(scope, signal);

			const rule = replyOf(
				Rule,
				await scope.send({ ...fields, type: "rule", action, caller: scope.caller }, signal),
				"rule",
			);

			return { text: `${ruleLine(rule, names)}\n`, data: { action, value: rule } };
		}

		case "list": {
			const { entries, text } = await sendRuleList(args.kind === undefined ? {} : { kind: args.kind }, scope);

			return { text, data: { action, value: { rules: entries.map(({ rule }) => rule) } } };
		}

		default:
			throw new Error(`Unknown action: ${String(action)}`);
	}
}

/** The rules of `filter`, in ID order, each with its line, and the text of the list, or `No rules`. */
export async function sendRuleList(
	filter: RuleFilter,
	scope: ProjectScope,
): Promise<{ entries: { rule: Rule; line: string }[]; text: string }> {
	const signal = scope.signal ?? NO_ABORT;
	const reply = await scope.send({ type: "rule", action: "list", ...filter }, signal);
	const list = replyOf(RuleList, reply, "list of rules");
	const names = await sendPersonNames(scope, signal);
	const entries = list.rules.map((rule) => ({ rule, line: ruleLine(rule, names) }));

	return { entries, text: listText(entries, ({ line }) => line, "No rules") };
}

/** Sends the change `change` of a rule by the user, and gives the rule and its line. No tool sends it. */
export async function sendRuleChange(
	change: RuleUserChange,
	scope: ProjectScope,
): Promise<{ rule: Rule; text: string }> {
	const signal = scope.signal ?? NO_ABORT;
	const rule = replyOf(Rule, await scope.send({ ...change, type: "rule", caller: scope.caller }, signal), "rule");
	const names = await sendPersonNames(scope, signal);

	return { rule, text: `${ruleLine(rule, names)}\n` };
}

/**
 * Sends the note `note` of the ask `n` for the caller of `scope`, and gives the ask and its line.
 * The ask is its number in the parley `slug`, or its ID without `slug`.
 */
export async function sendAskNote(
	slug: string | undefined,
	n: number,
	note: string,
	scope: ProjectScope,
): Promise<{ ask: Ask; text: string }> {
	const request = { type: "ask", action: "note", caller: scope.caller, ...askRef(slug, n), note } as const;
	const ask = replyOf(Ask, await scope.send(request, scope.signal ?? NO_ABORT), "ask");

	return { ask, text: `${askLine(ask)}\n` };
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
	const { slug, title, goal, evidence, design_sense, item } = args;

	if (slug === undefined) {
		if ([title, goal, evidence, design_sense, item].some((field) => field !== undefined))
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
			const item = args.item === undefined ? {} : { item: args.item };
			const request = frame === undefined ? round : { ...round, parley: frame, ...item };
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

		case "note": {
			const n = required(args.ask, "ask", action);
			const { ask, text } = await sendAskNote(slug, n, required(args.note, "note", action), scope);

			return { text, data: { action, value: ask } };
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

export type ItemArgs = Static<ProjectSchemas["item"]["parameters"]>;

/** Runs one call of the `item` tool, for the tool and `harness item`. */
export async function runItemTool(args: ItemArgs, scope: ProjectScope) {
	const { action } = args;
	const signal = scope.signal ?? NO_ABORT;
	const caller = scope.caller;

	switch (action) {
		case "add": {
			const add = { type: "item", action, caller, title: required(args.title, "title", action) } as const;
			const request = args.text === undefined ? add : { ...add, text: args.text };
			const item = replyOf(StagedItem, await scope.send(request, signal), "item");

			return { text: `${itemLine(item)}\n`, data: { action, value: item } };
		}

		case "set": {
			let request: Extract<Request, { type: "item"; action: "set" }> = {
				type: "item",
				action,
				caller,
				id: required(args.id, "id", action),
			};

			if (args.title !== undefined) request = { ...request, title: args.title };

			if (args.text !== undefined) request = { ...request, text: args.text };

			if (args.state !== undefined) request = { ...request, state: args.state };
			const item = replyOf(StagedItem, await scope.send(request, signal), "item");

			return { text: `${itemLine(item)}\n`, data: { action, value: item } };
		}

		case "list": {
			const list =
				args.state === undefined
					? ({ type: "item", action } as const)
					: ({ type: "item", action, state: args.state } as const);

			const reply = replyOf(ItemList, await scope.send(list, signal), "list of items");

			return { text: listText(reply.items, itemLine, "No items"), data: { action, value: reply } };
		}

		case "read": {
			const request = { type: "item", action, id: required(args.id, "id", action) } as const;
			const item = replyOf(StagedItem, await scope.send(request, signal), "item");

			return { text: itemText(item), data: { action, value: item } };
		}

		case "link": {
			const from = required(args.from, "from", action);
			const to = required(args.to, "to", action);
			const kind = required(args.kind, "kind", action);
			// The host checks the references too: this check fails before any request.
			const invalid = [from, to].find((ref): boolean => !Value.Check(Ref, ref));

			if (invalid !== undefined) throw new Error(`Invalid item reference: ${invalid}`);
			const request = { type: "item", action, caller, from, kind, to } as const;

			const edge = replyOf(Edge, await scope.send(request, signal), "edge");

			return { text: `${edgeLine(edge)}\n`, data: { action, value: edge } };
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

	return durable.defineExtension({ name: PROJECT_EXTENSION, tools });
}
