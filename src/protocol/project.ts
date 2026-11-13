import { type Static, Type } from "typebox";

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

/** The states of a message: `received` for a message in, `draft` for a message out. */
export const MESSAGE_STATES = ["received", "draft"] as const;

export const MessageState = Type.Enum(MESSAGE_STATES);

export type MessageState = Static<typeof MessageState>;

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

/** The states of a held action: `held` until the user approves or drops it. */
export const HELD_STATES = ["held", "approved", "dropped"] as const;

export const HeldState = Type.Enum(HELD_STATES);

export type HeldState = Static<typeof HeldState>;

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
 * A tool call that the gate held. Only an approved action has `ran`: the request ID of the one call that it let run,
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

/** The kind of the entry of a message in the conversation of its thread. */
export const MESSAGE_KIND = "harness.message";

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

/** A thread and its messages, oldest first. */
export const ThreadMessages = Type.Object({ thread: Thread, messages: Type.Array(Message) });

export type ThreadMessages = Static<typeof ThreadMessages>;

/** A thread of `watch-project`, with its messages in the state `draft`, oldest first. */
export const ProjectThread = Type.Object({ ...Thread.properties, drafts: Type.Array(Message) });

export type ProjectThread = Static<typeof ProjectThread>;

/**
 * The reply of `watch-project`: every person, rule, term, thread with its drafts, part and held action, in ID order.
 */
export const ProjectState = Type.Object({
	persons: Type.Array(Person),
	rules: Type.Array(Rule),
	terms: Type.Array(Term),
	threads: Type.Array(ProjectThread),
	parts: Type.Array(Part),
	held: Type.Array(HeldAction),
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
