import { type Static, Type } from "typebox";

/** The ID of a person, a rule, a term or a part: its place in its list, 1, 2, 3 and so on. */
const LocalId = Type.Integer({ minimum: 1 });

/** The ID of a thread, which is the ID of its conversation, or of a message, which is the ID of its entry. */
const StoreId = Type.Integer({ minimum: 1 });

/** A text with at least one character that is not white space. */
const Text = Type.String({ pattern: "\\S" });

/** A time in epoch milliseconds. */
const Time = Type.Integer({ minimum: 0 });

/** Who said or wrote something: the ID of a person, or `user`. */
export const Author = Type.Union([LocalId, Type.Literal("user")]);

export type Author = Static<typeof Author>;

/** A person that the user talks with. */
export const Person = Type.Object({ id: LocalId, name: Text });

export type Person = Static<typeof Person>;

/** A thread of messages with one or more persons. Its ID is the ID of its conversation. */
export const Thread = Type.Object({ id: StoreId, topic: Text, persons: Type.Array(LocalId, { minItems: 1 }) });

export type Thread = Static<typeof Thread>;

/** The directions of a message: `in` from a person, `out` to the persons. */
export const MESSAGE_DIRECTIONS = ["in", "out"] as const;

export const MessageDirection = Type.Enum(MESSAGE_DIRECTIONS);

export type MessageDirection = Static<typeof MessageDirection>;

/** The states of a message: `received` for a message in, `draft` for a message out. */
export const MESSAGE_STATES = ["received", "draft"] as const;

export const MessageState = Type.Enum(MESSAGE_STATES);

export type MessageState = Static<typeof MessageState>;

/** A message of a thread. Its ID is the ID of its entry, and `at` is in epoch milliseconds. */
export const Message = Type.Object({
	id: StoreId,
	thread: StoreId,
	from: Author,
	direction: MessageDirection,
	state: MessageState,
	at: Time,
	text: Text,
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
 * epoch milliseconds.
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
});

export type Rule = Static<typeof Rule>;

/** A term of the project, its meaning and the words not to use for it, with who said it and its source message. */
export const Term = Type.Object({
	id: LocalId,
	name: Text,
	meaning: Text,
	avoid: Type.Array(Text),
	saidBy: Author,
	source: StoreId,
	at: Time,
});

export type Term = Static<typeof Term>;

/** The kinds of a part. */
export const PART_KINDS = ["diagram", "table", "example", "widget"] as const;

export const PartKind = Type.Enum(PART_KINDS);

export type PartKind = Static<typeof PartKind>;

/**
 * A part of the vault that explains rules and terms. `checked` is the time of its last check, in epoch milliseconds,
 * and `stale` is true once one of its rules or terms changed after it.
 */
export const Part = Type.Object({
	id: LocalId,
	kind: PartKind,
	path: Text,
	rules: Type.Array(LocalId),
	terms: Type.Array(LocalId),
	checked: Time,
	stale: Type.Boolean(),
});

export type Part = Static<typeof Part>;

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

/** The kind of the entry of a message in the conversation of its thread. */
export const MESSAGE_KIND = "harness.message";

export type PersonList = { persons: Person[] };

export type ThreadList = { threads: Thread[] };

export type RuleList = { rules: Rule[] };

export type TermList = { terms: Term[] };

export type PartList = { parts: Part[] };

/** A thread and its messages, oldest first. */
export type ThreadMessages = { thread: Thread; messages: Message[] };
