import { type Static, Type } from "typebox";
import { SLUG } from "./paths.ts";

/** The ID of a person, a rule, a term, a part or a held action: its place in its list, 1, 2, 3 and so on. */
export const LocalId = Type.Integer({ minimum: 1 });

/** The ID of a thread, which is the ID of its conversation, or of a message, which is the ID of its entry. */
const StoreId = Type.Integer({ minimum: 1 });

/** A text with at least one character that is not white space. */
const Text = Type.String({ pattern: "\\S" });

/** A time in epoch milliseconds. */
const Time = Type.Integer({ minimum: 0 });

/** The caller of the request that wrote an object last: the conversation ID of a hosted agent, or a Pi session ID. */
const Caller = Type.String();

/** Who said or wrote something: the ID of a person, or `user`. */
export const Author = Type.Union([LocalId, Type.Literal("user")]);

export type Author = Static<typeof Author>;

/** A person that the user talks with. */
export const Person = Type.Object({ id: LocalId, name: Text });

export type Person = Static<typeof Person>;

/**
 * A thread of messages with one or more persons. Its ID is the ID of its conversation, and `last` is the latest `at` of
 * its messages, absent while it has none.
 */
export const Thread = Type.Object({
	id: StoreId,
	topic: Text,
	persons: Type.Array(LocalId, { minItems: 1 }),
	last: Type.Optional(Time),
});

export type Thread = Static<typeof Thread>;

/** The directions of a message: `in` from a person, `out` to the persons. */
export const MESSAGE_DIRECTIONS = ["in", "out"] as const;

export const MessageDirection = Type.Enum(MESSAGE_DIRECTIONS);

export type MessageDirection = Static<typeof MessageDirection>;

/**
 * The states of a message: `received` for a message in, and for a message out `draft`, `sent`, `answered` or
 * `dropped`.
 */
export const MESSAGE_STATES = ["received", "draft", "sent", "answered", "dropped"] as const;

export const MessageState = Type.Enum(MESSAGE_STATES);

export type MessageState = Static<typeof MessageState>;

/** The states that a request can mark a message out with. */
export const MESSAGE_MARKS = ["sent", "draft", "dropped"] as const;

export const MessageMark = Type.Enum(MESSAGE_MARKS);

export type MessageMark = Static<typeof MessageMark>;

/** An event of a message out: a mark, or `reply`, a later message in of a person of its thread. */
export type MessageEvent = MessageMark | "reply";

/**
 * The state of a message out in the state `state` after `event`, or `undefined` when the event cannot change it. A draft
 * becomes `sent` with a mark `sent` or a reply, and `dropped` with a mark `dropped`. A sent message becomes `draft` with
 * a mark `draft`, and `answered` with a reply.
 */
export function messageTransition(state: MessageState, event: MessageEvent): MessageState | undefined {
	switch (state) {
		case "draft":
			if (event === "sent" || event === "reply") return "sent";

			return event === "dropped" ? "dropped" : undefined;
		case "sent":
			if (event === "reply") return "answered";

			return event === "draft" ? "draft" : undefined;
		default:
			return undefined;
	}
}

/** Whether a message in the state `state` waits on the user or on a person: a draft, or a sent message. */
export function isWaiting(state: MessageState): boolean {
	return state === "draft" || state === "sent";
}

/**
 * A message of a thread. Its ID is the ID of its entry, `at` is in epoch milliseconds, and `by` is the caller that logged
 * it.
 */
export const Message = Type.Object({
	id: StoreId,
	thread: StoreId,
	from: Author,
	direction: MessageDirection,
	state: MessageState,
	at: Time,
	text: Text,
	by: Caller,
});

export type Message = Static<typeof Message>;

/** The kinds of a rule: `conduct` for how an agent acts, `domain` for a fact of the project. */
export const RULE_KINDS = ["conduct", "domain"] as const;

export const RuleKind = Type.Enum(RULE_KINDS);

export type RuleKind = Static<typeof RuleKind>;

/** The states of a rule. */
export const RULE_STATES = ["open", "decided", "retired"] as const;

export const RuleStatus = Type.Enum(RULE_STATES);

export type RuleStatus = Static<typeof RuleStatus>;

/**
 * A rule of the project, with who said it and the message that is its source. `at` is the time of its last change, in
 * epoch milliseconds, and `by` is the caller of that change.
 */
export const Rule = Type.Object({
	id: LocalId,
	name: Text,
	kind: RuleKind,
	value: Text,
	status: RuleStatus,
	saidBy: Author,
	source: StoreId,
	replaces: Type.Optional(LocalId),
	at: Time,
	by: Caller,
});

export type Rule = Static<typeof Rule>;

/**
 * A term of the project, its meaning and the words not to use for it, with who said it and its source message. `at` is
 * the time of its last change, and `by` is the caller of that change.
 */
export const Term = Type.Object({
	id: LocalId,
	name: Text,
	meaning: Text,
	avoid: Type.Array(Text),
	saidBy: Author,
	source: StoreId,
	at: Time,
	by: Caller,
});

export type Term = Static<typeof Term>;

/** The kinds of a part. */
export const PART_KINDS = ["diagram", "table", "example", "widget"] as const;

export const PartKind = Type.Enum(PART_KINDS);

export type PartKind = Static<typeof PartKind>;

/**
 * A part of the vault that explains rules and terms. `checked` is the time of its last check, in epoch milliseconds,
 * and `stale` is true once one of its rules or terms changed after it. `by` is the caller that added or checked it last.
 */
export const Part = Type.Object({
	id: LocalId,
	kind: PartKind,
	path: Text,
	rules: Type.Array(LocalId),
	terms: Type.Array(LocalId),
	checked: Time,
	stale: Type.Boolean(),
	by: Caller,
});

export type Part = Static<typeof Part>;

/**
 * The fields of each held action: the request ID of the call that the gate held, the caller that made it, its tool, its
 * command as it runs, the decided conduct rule that it breaks, absent when the gate failed, and the reason. `at` is the
 * time of its last change, and `by` is the caller of that change.
 */
const HeldFields = {
	id: LocalId,
	requestId: Type.String(),
	agent: Caller,
	tool: Type.String(),
	command: Type.String(),
	rule: Type.Optional(LocalId),
	reason: Type.String(),
	at: Time,
	by: Caller,
};

/**
 * A tool call that the gate held, in one of its three states: `held` until the user approves or drops it, then `approved`
 * or `dropped`. Only an approved action has `ran`: the request ID of the one call that it let run,
 * and its time.
 */
export const HeldAction = Type.Union([
	Type.Object({ ...HeldFields, state: Type.Literal("held") }),
	Type.Object({
		...HeldFields,
		state: Type.Literal("approved"),
		ran: Type.Optional(Type.Object({ requestId: Type.String(), at: Time })),
	}),
	Type.Object({ ...HeldFields, state: Type.Literal("dropped") }),
]);

export type HeldAction = Static<typeof HeldAction>;

/** The input of a new held action. */
export type HeldInput = Pick<HeldAction, "requestId" | "agent" | "tool" | "command" | "rule" | "reason">;

/**
 * A plain text: at least one character that is not white space, with no backtick and no `**`, as the parley skill
 * checks it.
 */
const Plain = Type.String({ pattern: "^(?![\\s\\S]*(`|\\*\\*))[\\s\\S]*\\S" });

/** A list of plain texts that is not empty. */
const Plains = Type.Array(Plain, { minItems: 1 });

/** The slug of a parley: lowercase words of letters and digits, joined by hyphens. */
export const Slug = Type.String({ pattern: SLUG.source });

/** The kinds of an ask: `your call` for a choice of the user, `my call` for a choice of the asker. */
export const ASK_KINDS = ["your call", "my call"] as const;

export const AskKind = Type.Enum(ASK_KINDS);

/** The key of an option: one lowercase letter. */
export const OptionKey = Type.String({ pattern: "^[a-z]$" });

/** An option of an ask, with what it gains and what it costs. */
export const AskOption = Type.Object({
	key: OptionKey,
	label: Plain,
	gains: Type.Optional(Plains),
	costs: Type.Optional(Plains),
});

export type AskOption = Static<typeof AskOption>;

/**
 * The question of an ask, as its asker writes it: its `title`, and when the asker has them its `kind`, `tension`,
 * `options`, `plan`, the key of the option that the asker proposes, and `view`, a text that explains it, in Markdown.
 */
const AskQuestion = {
	title: Plain,
	kind: Type.Optional(AskKind),
	tension: Type.Optional(Plain),
	options: Type.Optional(Type.Array(AskOption, { minItems: 1 })),
	plan: Type.Optional(OptionKey),
	view: Type.Optional(Text),
};

/** The input of a new ask. Its option keys are unique, and its `plan` is the key of one of its options. */
export const AskInput = Type.Refine(
	Type.Object(AskQuestion),
	(ask) => {
		const keys = (ask.options ?? []).map((option) => option.key);

		return new Set(keys).size === keys.length && (ask.plan === undefined || keys.includes(ask.plan));
	},
	() => "must have unique option keys and a plan that is one of them",
);

export type AskInput = Static<typeof AskInput>;

/** The exact words of the user in an answer, which can quote code or Markdown. */
const Words = Type.Array(Text, { minItems: 1 });

/** The fields of an answer that the user gave in his own words: `own`, with the `label` that he gave it. */
const OwnAnswer = { answer: Type.Literal("own"), label: Plain, words: Type.Optional(Words) };

/** The fields of an answer that takes a key: the key of an option, or `ok` to the read-back of a parley. */
const KeyAnswer = {
	answer: Type.Union([OptionKey, Type.Literal("ok")]),
	label: Type.Optional(Plain),
	words: Type.Optional(Words),
};

/** The fields of each ask: its question, the parley that it serves with its number there, its asker, and its last change. */
const AskFields = {
	id: LocalId,
	...AskQuestion,
	parley: Type.Optional(Type.Object({ id: LocalId, n: LocalId })),
	asker: Caller,
	at: Time,
	by: Caller,
};

/**
 * A question that someone put to the user, in one of its states: `open`, then `answered` or `dropped`. `asker` is the
 * caller that wrote it or took its parley last. `parley` is the parley that it serves, and `n` its number there, which
 * never changes. `at` is the time of its last change, and `by` the caller of that change.
 */
export const Ask = Type.Union([
	Type.Object({ ...AskFields, state: Type.Literal("open") }),
	Type.Object({ ...AskFields, state: Type.Literal("answered"), ...OwnAnswer }),
	Type.Object({ ...AskFields, state: Type.Literal("answered"), ...KeyAnswer }),
	Type.Object({ ...AskFields, state: Type.Literal("dropped") }),
]);

export type Ask = Static<typeof Ask>;

/** The states of an ask. */
export type AskState = Ask["state"];

/** An event of an ask: an answer, or a drop. */
export type AskEvent = "answer" | "drop";

/**
 * The state of an ask in the state `state` after `event`, or `undefined` when the event cannot change it. An open ask
 * takes an answer and a drop. An answered ask takes a new answer, which replaces the old one. A dropped ask takes
 * nothing.
 */
export function askTransition(state: AskState, event: AskEvent): AskState | undefined {
	switch (state) {
		case "open":
			return event === "answer" ? "answered" : "dropped";
		case "answered":
			return event === "answer" ? "answered" : undefined;
		default:
			return undefined;
	}
}

/** The input of an answer of the ask `id`. */
export const AnswerInput = Type.Union([
	Type.Object({ id: LocalId, ...OwnAnswer }),
	Type.Object({ id: LocalId, ...KeyAnswer }),
]);

export type AnswerInput = Static<typeof AnswerInput>;

/** The answers of one write, one or more, each of another ask. */
export const AnswerInputs = Type.Refine(
	Type.Array(AnswerInput, { minItems: 1 }),
	(answers) => new Set(answers.map((answer) => answer.id)).size === answers.length,
	() => "must answer each ask once",
);

/** The statuses that end a contract. */
export const ParleyEnd = Type.Union([Type.Literal("done"), Type.Literal("dropped")]);

export type ParleyEnd = Static<typeof ParleyEnd>;

/** The frame of a parley, as a round writes it: the slug and the fields that change. */
export const ParleyFrame = Type.Object({
	slug: Slug,
	title: Type.Optional(Plain),
	goal: Type.Optional(Plain),
	evidence: Type.Optional(Plains),
	design_sense: Type.Optional(Plain),
});

export type ParleyFrame = Static<typeof ParleyFrame>;

const ParleyFields = {
	id: LocalId,
	slug: Slug,
	title: Plain,
	goal: Plain,
	evidence: Type.Optional(Plains),
	at: Time,
	by: Caller,
};

/**
 * A group of asks with a frame: its slug, unique in the project, its title, its goal, its evidence and its design
 * sense, which a parley needs from its contract on. It names no asker and no asks: each ask names its parley. `at` is the
 * time of its last change, and `by` the caller of that change.
 */
export const Parley = Type.Union([
	Type.Object({ ...ParleyFields, status: Type.Literal("open"), design_sense: Type.Optional(Plain) }),
	Type.Object({
		...ParleyFields,
		status: Type.Union([Type.Literal("contract"), ParleyEnd]),
		design_sense: Plain,
	}),
]);

export type Parley = Static<typeof Parley>;

/** The input of a round: the frame of its parley, when it has one, and one or more asks. */
export const AskRound = Type.Object({
	parley: Type.Optional(ParleyFrame),
	asks: Type.Array(AskInput, { minItems: 1 }),
});

export type AskRound = Static<typeof AskRound>;

/** The input of a new person. */
export const PersonAdd = Type.Object({ name: Text });

export type PersonAdd = Static<typeof PersonAdd>;

/** The input of a new thread, with one or more persons. */
export const ThreadAdd = Type.Object({ topic: Thread.properties.topic, persons: Thread.properties.persons });

export type ThreadAdd = Static<typeof ThreadAdd>;

/** The input of a new message. The host sets its state from its direction, and `at` defaults to now. */
export const MessageLog = Type.Object({
	thread: StoreId,
	from: Author,
	direction: MessageDirection,
	at: Type.Optional(Time),
	text: Text,
});

export type MessageLog = Static<typeof MessageLog>;

/** The input of a mark of the message out `message` with `state`. */
export const MessageMarkInput = Type.Object({ message: StoreId, state: MessageMark });

export type MessageMarkInput = Static<typeof MessageMarkInput>;

/** The input of a new rule, which can replace an older rule. Its status defaults to `open`. */
export const RuleNew = Type.Object({
	id: Type.Optional(Type.Never()),
	name: Text,
	kind: RuleKind,
	value: Text,
	status: Type.Optional(RuleStatus),
	saidBy: Author,
	source: StoreId,
	replaces: Type.Optional(LocalId),
});

export type RuleNew = Static<typeof RuleNew>;

/** The input of a change of the rule `id`. The host refuses `replaces` on a change. */
export const RuleEdit = Type.Object({
	id: LocalId,
	name: Type.Optional(Text),
	kind: Type.Optional(RuleKind),
	value: Type.Optional(Text),
	status: Type.Optional(RuleStatus),
	saidBy: Author,
	source: StoreId,
	replaces: Type.Optional(LocalId),
});

export type RuleEdit = Static<typeof RuleEdit>;

/** The input of a rule set: a new rule without `id`, a change of a rule with `id`. */
export const RuleSet = Type.Union([RuleNew, RuleEdit]);

export type RuleSet = Static<typeof RuleSet>;

/** The filter of a read of the rules: only the rules of `kind` and of `status` when they are given. */
export const RuleFilter = Type.Object({ kind: Type.Optional(RuleKind), status: Type.Optional(RuleStatus) });

export type RuleFilter = Static<typeof RuleFilter>;

/** The input of a new term. `avoid` defaults to no words. */
export const TermNew = Type.Object({
	id: Type.Optional(Type.Never()),
	name: Text,
	meaning: Text,
	avoid: Type.Optional(Type.Array(Text)),
	saidBy: Author,
	source: StoreId,
});

export type TermNew = Static<typeof TermNew>;

/** The input of a change of the term `id`. */
export const TermEdit = Type.Object({
	id: LocalId,
	name: Type.Optional(Text),
	meaning: Type.Optional(Text),
	avoid: Type.Optional(Type.Array(Text)),
	saidBy: Author,
	source: StoreId,
});

export type TermEdit = Static<typeof TermEdit>;

/** The input of a term set: a new term without `id`, a change of a term with `id`. */
export const TermSet = Type.Union([TermNew, TermEdit]);

export type TermSet = Static<typeof TermSet>;

/** The input of a new part that explains `rules` and `terms`. */
export const PartAdd = Type.Object({
	kind: PartKind,
	path: Text,
	rules: Type.Array(LocalId),
	terms: Type.Array(LocalId),
});

export type PartAdd = Static<typeof PartAdd>;

/** The filter of a read of the parts: only the parts that explain the rule `rule` and the term `term` when they are given. */
export const PartFilter = Type.Object({ rule: Type.Optional(LocalId), term: Type.Optional(LocalId) });

export type PartFilter = Static<typeof PartFilter>;

/** The kinds of the documents of the project in the store, one for each list. */
export const PERSONS_KIND = "harness.persons";
export const THREADS_KIND = "harness.threads";
export const RULES_KIND = "harness.rules";
export const TERMS_KIND = "harness.terms";
export const PARTS_KIND = "harness.parts";
export const HELD_KIND = "harness.held";
export const PARLEYS_KIND = "harness.parleys";
export const ASKS_KIND = "harness.asks";

/** The kind of the document of the session with the state of each message out. */
export const OUTBOX_KIND = "harness.outbox";

/** The kind of the entry of a message in the conversation of its thread. */
export const MESSAGE_KIND = "harness.message";

/** The kind of the entry of a digest in the conversation of a hosted agent. */
export const DIGEST_KIND = "harness.digest";

/** The reply of `digest`: the text of the digest that the caller gets, absent when it gets none. */
export const DigestReply = Type.Object({ text: Type.Optional(Type.String()) });

export type DigestReply = Static<typeof DigestReply>;

export const PersonList = Type.Object({ persons: Type.Array(Person) });

export type PersonList = Static<typeof PersonList>;

export const ThreadList = Type.Object({ threads: Type.Array(Thread) });

export type ThreadList = Static<typeof ThreadList>;

export const RuleList = Type.Object({ rules: Type.Array(Rule) });

export type RuleList = Static<typeof RuleList>;

export const TermList = Type.Object({ terms: Type.Array(Term) });

export type TermList = Static<typeof TermList>;

export const PartList = Type.Object({ parts: Type.Array(Part) });

export type PartList = Static<typeof PartList>;

export const HeldList = Type.Object({ held: Type.Array(HeldAction) });

export type HeldList = Static<typeof HeldList>;

export const ParleyList = Type.Object({ parleys: Type.Array(Parley) });

export type ParleyList = Static<typeof ParleyList>;

export const AskList = Type.Object({ asks: Type.Array(Ask) });

export type AskList = Static<typeof AskList>;

/** A parley and its asks, in the order of their numbers. */
export const ParleyAsks = Type.Object({ parley: Parley, asks: Type.Array(Ask) });

export type ParleyAsks = Static<typeof ParleyAsks>;

/** The reply of a write of asks: the parleys and the asks that it added or changed, in ID order. */
export const AskWrite = Type.Object({ parleys: Type.Array(Parley), asks: Type.Array(Ask) });

export type AskWrite = Static<typeof AskWrite>;

/** A thread and its messages, oldest first. */
export const ThreadMessages = Type.Object({ thread: Thread, messages: Type.Array(Message) });

export type ThreadMessages = Static<typeof ThreadMessages>;

/** A thread of `watch-project`, with its messages in the state `draft` or `sent`, oldest first. */
export const ProjectThread = Type.Object({ ...Thread.properties, waits: Type.Array(Message) });

export type ProjectThread = Static<typeof ProjectThread>;

/**
 * The reply of `watch-project`: every person, rule, term, thread with its waits, part, held action, parley and ask, in
 * ID order.
 */
export const ProjectState = Type.Object({
	persons: Type.Array(Person),
	rules: Type.Array(Rule),
	terms: Type.Array(Term),
	threads: Type.Array(ProjectThread),
	parts: Type.Array(Part),
	held: Type.Array(HeldAction),
	parleys: Type.Array(Parley),
	asks: Type.Array(Ask),
});

export type ProjectState = Static<typeof ProjectState>;

/**
 * An event of `watch-project` after its reply: the objects of each kind that are new or changed, and in `removed` the
 * IDs of each kind of the objects that went. Every list is there, empty when nothing of its kind changed.
 */
export const ProjectEvent = Type.Object({
	...ProjectState.properties,
	removed: Type.Object({
		persons: Type.Array(LocalId),
		rules: Type.Array(LocalId),
		terms: Type.Array(LocalId),
		threads: Type.Array(StoreId),
		parts: Type.Array(LocalId),
		held: Type.Array(LocalId),
		parleys: Type.Array(LocalId),
		asks: Type.Array(LocalId),
	}),
});

export type ProjectEvent = Static<typeof ProjectEvent>;

/** The names of the persons, by ID. */
export type PersonNames = ReadonlyMap<number, string>;

/** The names of the persons of `list`, by ID. */
export function personNames(list: PersonList): PersonNames {
	return new Map(list.persons.map((person) => [person.id, person.name]));
}

/**
 * `author` in a line: `user`, the name of the person and its ID, as `Sam (1)`, or `person <id>` for a person that
 * `names` does not have.
 */
export function authorText(author: Author, names: PersonNames): string {
	if (author === "user") return author;
	const name = names.get(author);

	return name === undefined ? `person ${author}` : `${name} (${author})`;
}

function time(at: number): string {
	return new Date(at).toISOString();
}

export function threadLine(thread: Thread, names: PersonNames): string {
	const persons = thread.persons.map((person) => authorText(person, names)).join(", ");
	const last = thread.last === undefined ? "no messages" : `last message ${time(thread.last)}`;

	return `${thread.id} ${thread.topic} with ${persons}: ${last}`;
}

export function messageLine(message: Message, names: PersonNames): string {
	return `${message.id} ${time(message.at)} ${authorText(message.from, names)} (${message.state}): ${message.text}`;
}

function saidLine(fact: Pick<Rule, "saidBy" | "source">, names: PersonNames): string {
	return `said by ${authorText(fact.saidBy, names)} in message ${fact.source}`;
}

export function ruleLine(rule: Rule, names: PersonNames): string {
	const replaces = rule.replaces === undefined ? "" : `; replaces ${rule.replaces}`;

	return `${rule.id} ${rule.name} (${rule.kind}, ${rule.status}): ${rule.value} [${saidLine(rule, names)}${replaces}]`;
}

export function termLine(term: Term, names: PersonNames): string {
	const avoid = term.avoid.length === 0 ? "" : `avoid ${term.avoid.join(", ")}; `;

	return `${term.id} ${term.name}: ${term.meaning} [${avoid}${saidLine(term, names)}]`;
}

function idsText(ids: readonly number[]): string {
	return ids.length === 0 ? "none" : ids.join(", ");
}

export function partLine(part: Part): string {
	const stale = part.stale ? " stale" : "";

	return `${part.id} ${part.kind} ${part.path} [rules ${idsText(part.rules)}; terms ${idsText(part.terms)}; checked ${time(part.checked)}]${stale}`;
}

/** The fields of a line of a parley or an ask, joined with ` · `. */
function fieldsText(fields: readonly (string | number | undefined)[]): string {
	return fields.filter((field) => field !== undefined).join(" · ");
}

export function parleyLine(parley: Parley): string {
	return fieldsText([parley.slug, parley.status, parley.title]);
}

/** The label of the option `key` of `ask`, when it has one. */
function optionLabel(ask: Ask, key: string | undefined): string | undefined {
	return ask.options?.find((option) => option.key === key)?.label;
}

/** The label of the answer of `ask`: its own label, else the label of the chosen option, else the label of the answer. */
function answerLabel(ask: Extract<Ask, { readonly state: "answered" }>): string | undefined {
	return ask.answer === "own" ? ask.label : (optionLabel(ask, ask.answer) ?? ask.label);
}

/** The number of `ask` in its parley, or its ID when it has no parley. */
function askNumber(ask: Ask): number {
	return ask.parley?.n ?? ask.id;
}

/**
 * The line of `ask`, with its number in its parley, or its ID when it has no parley: its title, its kind, then `open`
 * with its plan and the label of the plan, its answer and the label of the answer, or `dropped`.
 */
export function askLine(ask: Ask): string {
	const head = [askNumber(ask), ask.title, ask.kind];

	switch (ask.state) {
		case "open": {
			const plan = ask.plan === undefined ? [] : [`plan ${ask.plan}`, optionLabel(ask, ask.plan)];

			return fieldsText([...head, "open", ...plan]);
		}

		case "answered":
			return fieldsText([...head, ask.answer, answerLabel(ask)]);

		default:
			return fieldsText([...head, ask.state]);
	}
}

/** The text of the answered ask `ask` with no parley: its line, then each of the words of the user on its own line. */
export function askAnswerText(ask: Ask): string {
	const words = ask.state === "answered" ? (ask.words ?? []) : [];

	return [askLine(ask), ...words].map((line) => `${line}\n`).join("");
}

/**
 * The last line of the parley `parley` with its asks `asks`. For an open parley, the answer line: the plan of each open
 * your call with a plan, then `ok` when no ask is open or when another ask is open. For any other status, the command
 * that shows the parley.
 */
function parleyAnswerLine(parley: Parley, asks: readonly Ask[]): string {
	if (parley.status !== "open") return `harness parley show ${parley.slug}`;
	const open = asks.filter((ask) => ask.state === "open");
	const calls = open.filter((ask) => ask.kind === "your call" && ask.plan !== undefined);
	const parts = calls.map((ask) => `${askNumber(ask)}${ask.plan}`);

	if (open.length === 0 || calls.length < open.length) parts.push("ok");

	return `[${parley.slug}] ${parts.join(" ")}`;
}

/** The text of a parley: its line, the line of each of its asks, and its answer line. */
export function parleyText(reply: ParleyAsks): string {
	return [parleyLine(reply.parley), ...reply.asks.map(askLine), parleyAnswerLine(reply.parley, reply.asks)]
		.map((line) => `${line}\n`)
		.join("");
}

/** The state line of `ask` in the text of `harness parley show`: its answer, its plan when it is open, or `Dropped`. */
function askStateText(ask: Ask): string {
	switch (ask.state) {
		case "open": {
			const label = optionLabel(ask, ask.plan);

			return ask.plan === undefined ? "Open" : `Open, plan ${ask.plan}${label === undefined ? "" : `: ${label}`}`;
		}

		case "answered":
			return `Answer: ${answerLabel(ask) ?? ask.answer}`;

		default:
			return "Dropped";
	}
}

/**
 * The text of `harness parley show`, in Markdown: the title of the parley, with its status when it is done or dropped,
 * its goal, then each ask with options, with its state and the words of the user, then the design sense and the
 * evidence when they are set. It leaves out the read-back, which is the ask with no options.
 */
export function parleyShowText(reply: ParleyAsks): string {
	const { parley } = reply;
	const status = parley.status === "done" || parley.status === "dropped" ? ` (${parley.status})` : "";
	const blocks = [`# ${parley.title}${status}`, parley.goal];

	for (const ask of reply.asks) {
		if (ask.options === undefined) continue;
		blocks.push(`## ${askNumber(ask)}. ${ask.title}`, askStateText(ask));

		if (ask.state === "answered") blocks.push(...(ask.words ?? []));
	}

	if (parley.design_sense !== undefined) blocks.push("## Design sense", parley.design_sense);

	if (parley.evidence !== undefined) {
		blocks.push("## Evidence", parley.evidence.map((item) => `- ${item}`).join("\n"));
	}

	return `${blocks.join("\n\n")}\n`;
}
