import { type Static, type TProperties, Type } from "typebox";
import { SLUG } from "./paths.ts";
import { isFinished } from "./todo.ts";

/**
 * The name of the durable extension with the tools of the store of the project: `thread`, `rule` and `parley`. A
 * client of `children.open` leaves these tools out when its `setup` adds this name to the `remove` of the extensions
 * of the child's `AgentDoc`.
 */
export const PROJECT_EXTENSION = "harness-project";

/**
 * The name of the durable extension with the `memory` tool and the memory section of the system prompt. Only the
 * project agent gets it: `children.open` removes it from each child.
 */
export const MEMORY_EXTENSION = "harness-memory";

/** The key of the system prompt section with the memory of the project agent. */
export const MEMORY_SECTION = "memory";

/** The ID of a person, a rule or a held action: its place in its list, 1, 2, 3 and so on. */
export const LocalId = Type.Integer({ minimum: 1 });

/** The ID of a thread, which is the ID of its conversation, or of a message, which is the ID of its entry. */
const StoreId = Type.Integer({ minimum: 1 });

/** A text with at least one character that is not white space. */
const Text = Type.String({ pattern: "\\S" });

/** The ID of a note in the vault: the `id` of its front matter, kept as it is given. */
export const NoteId = Text;

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
 * A rule of the project, with who said it, the message that is its source, and the thread of that message. A rule that
 * the user creates or edits has no source and no thread. `at` is the time of its last change, in epoch milliseconds,
 * and `by` is the caller of that change.
 */
export const Rule = Type.Object({
	id: LocalId,
	name: Text,
	kind: RuleKind,
	value: Text,
	status: RuleStatus,
	saidBy: Author,
	source: Type.Optional(StoreId),
	/** The thread of the message `source`; a rule with no source has none. */
	thread: Type.Optional(StoreId),
	replaces: Type.Optional(LocalId),
	at: Time,
	by: Caller,
});

export type Rule = Static<typeof Rule>;

/**
 * The fields of each held action: the request ID of the call that the gate held, the caller that made it, its tool, its
 * command as it runs, the decided conduct rule that it breaks, absent when the gate failed or the call changes a rule,
 * and the reason. `at` is the time of its last change, and `by` is the caller of that change.
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

/**
 * The fields of each ask: its question, the parley that it serves with its number there, the ID of its note in the
 * vault, its asker, and its last change.
 */
const AskFields = {
	id: LocalId,
	...AskQuestion,
	parley: Type.Optional(Type.Object({ id: LocalId, n: LocalId })),
	note: Type.Optional(NoteId),
	asker: Caller,
	at: Time,
	by: Caller,
};

/**
 * The author of the last answer of an ask: the user, the agent of a conversation of the host, or another agent, which
 * the host knows only by its caller, such as the session ID of a Pi session.
 */
export const AnswerAuthor = Type.Union([
	Type.Object({ kind: Type.Literal("user") }),
	Type.Object({ kind: Type.Literal("hosted"), conversation: StoreId }),
	Type.Object({ kind: Type.Literal("agent"), caller: Type.String() }),
]);

export type AnswerAuthor = Static<typeof AnswerAuthor>;

/**
 * A question that someone put to the user, in one of its states: `open`, then `answered` or `dropped`. `asker` is the
 * caller that wrote it or took its parley last. `parley` is the parley that it serves, and `n` its number there, which
 * never changes. `note` is the ID of the note of the ask in the vault. `at` is the time of its last change, and `by`
 * the caller of that change. An answered ask has `author`, the author of its last answer.
 */
export const Ask = Type.Union([
	Type.Object({ ...AskFields, state: Type.Literal("open") }),
	Type.Object({ ...AskFields, state: Type.Literal("answered"), author: AnswerAuthor, ...OwnAnswer }),
	Type.Object({ ...AskFields, state: Type.Literal("answered"), author: AnswerAuthor, ...KeyAnswer }),
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

/**
 * The two objects with `fields` and an ask on the wire: one with `id`, the ID of the ask, and one with `slug` and `n`,
 * the number of the ask in the parley `slug`. Each refuses the keys of the other, because an object schema accepts extra
 * keys.
 */
export function withAskRef<F extends TProperties>(fields: F) {
	const absent = Type.Optional(Type.Never());
	const id = Type.Object({ ...fields, id: LocalId, slug: absent, n: absent });
	const numbered = Type.Object({ ...fields, slug: Slug, n: LocalId, id: absent });
	const branches: [typeof id, typeof numbered] = [id, numbered];

	return branches;
}

/** An ask on the wire: `{ id }`, or `{ slug, n }`, its number in the parley `slug`. */
export const AskRef = Type.Union(withAskRef({}));

export type AskRef = Static<typeof AskRef>;

/** The text that names the ask `ref`: `ask <id>`, or `<slug> ask <n>`. Two refs with the same text name the same ask. */
export function askRefText(ref: AskRef): string {
	return ref.id === undefined ? `${ref.slug} ask ${ref.n}` : `ask ${ref.id}`;
}

/** The input of an answer of the ask that `id`, or `slug` and `n`, names. */
export const AnswerInput = Type.Union([...withAskRef(OwnAnswer), ...withAskRef(KeyAnswer)]);

export type AnswerInput = Static<typeof AnswerInput>;

/** The answers of one write, one or more, each of another ask. */
export const AnswerInputs = Type.Refine(
	Type.Array(AnswerInput, { minItems: 1 }),
	(answers) => new Set(answers.map(askRefText)).size === answers.length,
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

/**
 * The input of a new rule of an agent, which can name the older rule that it replaces. Its status is `open`: only the
 * user changes the status of a rule.
 */
export const RuleNew = Type.Object({
	id: Type.Optional(Type.Never()),
	name: Text,
	kind: RuleKind,
	value: Text,
	status: Type.Optional(Type.Never()),
	saidBy: Author,
	source: StoreId,
	replaces: Type.Optional(LocalId),
});

export type RuleNew = Static<typeof RuleNew>;

/** The input of a change of the open rule `id` by an agent. The host refuses `replaces` on a change. */
export const RuleEdit = Type.Object({
	id: LocalId,
	name: Type.Optional(Text),
	kind: Type.Optional(RuleKind),
	value: Type.Optional(Text),
	status: Type.Optional(Type.Never()),
	saidBy: Author,
	source: StoreId,
	replaces: Type.Optional(LocalId),
});

export type RuleEdit = Static<typeof RuleEdit>;

/** The input of a rule set: a new rule without `id`, a change of a rule with `id`. */
export const RuleSet = Type.Union([RuleNew, RuleEdit]);

export type RuleSet = Static<typeof RuleSet>;

/**
 * A change of the status of the rule `id` by the user: `decide` puts an open rule in effect, `retire` ends an open or a
 * decided rule, and `delete` removes the rule.
 */
export const RuleStateChange = Type.Object({
	action: Type.Union([Type.Literal("decide"), Type.Literal("retire"), Type.Literal("delete")]),
	id: LocalId,
});

export type RuleStateChange = Static<typeof RuleStateChange>;

/** A change of the text of the rule `id`, in any status, by the user. */
export const RuleUserEdit = Type.Object({
	action: Type.Literal("edit"),
	id: LocalId,
	name: Type.Optional(Text),
	kind: Type.Optional(RuleKind),
	value: Type.Optional(Text),
});

export type RuleUserEdit = Static<typeof RuleUserEdit>;

/** A new rule of the user, which is decided. */
export const RuleCreate = Type.Object({ action: Type.Literal("create"), name: Text, kind: RuleKind, value: Text });

export type RuleCreate = Static<typeof RuleCreate>;

/** A change of a rule that only the user makes. */
export type RuleUserChange = RuleStateChange | RuleUserEdit | RuleCreate;

/** The filter of a read of the rules: only the rules of `kind` and of `status` when they are given. */
export const RuleFilter = Type.Object({ kind: Type.Optional(RuleKind), status: Type.Optional(RuleStatus) });

export type RuleFilter = Static<typeof RuleFilter>;

/** The kinds of the documents of the project in the store, one for each list. */
export const PERSONS_KIND = "harness.persons";
export const THREADS_KIND = "harness.threads";
export const RULES_KIND = "harness.rules";
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

export const HeldList = Type.Object({ held: Type.Array(HeldAction) });

export type HeldList = Static<typeof HeldList>;

export const ParleyList = Type.Object({ parleys: Type.Array(Parley) });

export type ParleyList = Static<typeof ParleyList>;

export const AskList = Type.Object({ asks: Type.Array(Ask) });

export type AskList = Static<typeof AskList>;

/** A parley and its asks, in the order of their numbers. */
export const ParleyAsks = Type.Object({ parley: Parley, asks: Type.Array(Ask) });

export type ParleyAsks = Static<typeof ParleyAsks>;

/**
 * The reply of a write of asks, from the commit of the write: each parley that it changed or whose asks it changed,
 * with all of its asks, in ID order, and the asks with no parley that it added or changed, in ID order.
 */
export const AskWrite = Type.Object({ parleys: Type.Array(ParleyAsks), asks: Type.Array(Ask) });

export type AskWrite = Static<typeof AskWrite>;

/** A thread and its messages, oldest first. */
export const ThreadMessages = Type.Object({ thread: Thread, messages: Type.Array(Message) });

export type ThreadMessages = Static<typeof ThreadMessages>;

/** A thread of `watch-project`, with its messages in the state `draft` or `sent`, oldest first. */
export const ProjectThread = Type.Object({ ...Thread.properties, waits: Type.Array(Message) });

export type ProjectThread = Static<typeof ProjectThread>;

/**
 * The kinds of the degraded states of a host: the gate classifier failed (`gate-classifier`), a classifier setting has
 * no model with a credential (`no-classifier`), a package or an entry was skipped at the start (`package-skipped`,
 * `entry-skipped`), a push of answers failed and waits (`push-failed`), the tell of an approved action failed
 * (`approve-tell`), answers of the user wait for an asker with no open `answers` request (`answer-waits`), the awake
 * hold failed (`awake-failed`), a catch-up or a digest failed (`catch-up-failed`, `digest-failed`), and the project
 * instructions and skills of a directory failed to load (`resources-failed`).
 */
export const DEGRADED_KINDS = [
	"gate-classifier",
	"no-classifier",
	"package-skipped",
	"entry-skipped",
	"push-failed",
	"approve-tell",
	"answer-waits",
	"awake-failed",
	"catch-up-failed",
	"digest-failed",
	"resources-failed",
] as const;

export const DegradedKind = Type.Enum(DEGRADED_KINDS);

export type DegradedKind = Static<typeof DegradedKind>;

/** A degraded state of the host: its kind, a line for the user, and the time of its start in epoch milliseconds. */
export const DegradedState = Type.Object({ kind: DegradedKind, line: Text, since: Time });

export type DegradedState = Static<typeof DegradedState>;

/**
 * The reply of `watch-project`: every person, rule, thread with its waits, held action, parley and ask, in ID order,
 * and the degraded states of the host, oldest first.
 */
export const ProjectState = Type.Object({
	persons: Type.Array(Person),
	rules: Type.Array(Rule),
	threads: Type.Array(ProjectThread),
	held: Type.Array(HeldAction),
	parleys: Type.Array(Parley),
	asks: Type.Array(Ask),
	degraded: Type.Array(DegradedState),
});

export type ProjectState = Static<typeof ProjectState>;

/**
 * An event of `watch-project` after its reply: the objects of each kind that are new or changed, and in `removed` the
 * IDs of each kind of the objects that went. Every list is there, empty when nothing of its kind changed. `degraded`
 * is the whole list of the degraded states of the host.
 */
export const ProjectEvent = Type.Object({
	...ProjectState.properties,
	removed: Type.Object({
		persons: Type.Array(LocalId),
		rules: Type.Array(LocalId),
		threads: Type.Array(StoreId),
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
	const source = fact.source === undefined ? "" : ` in message ${fact.source}`;

	return `said by ${authorText(fact.saidBy, names)}${source}`;
}

export function ruleLine(rule: Rule, names: PersonNames): string {
	const replaces = rule.replaces === undefined ? "" : `; replaces ${rule.replaces}`;

	return `${rule.id} ${rule.name} (${rule.kind}, ${rule.status}): ${rule.value} [${saidLine(rule, names)}${replaces}]`;
}

/** The key of the system prompt section with the decided rules of the project. */
export const RULES_SECTION = "project_rules";

/**
 * The text of the system prompt section of the decided rules in `rules`: the conduct rules, then the domain rules, each
 * group in ID order. It is undefined when no rule is decided.
 */
export function rulesSection(rules: readonly Rule[]): string | undefined {
	const decided = rules.filter((rule) => rule.status === "decided");

	if (decided.length === 0) return undefined;

	const lines = RULE_KINDS.flatMap((kind) =>
		decided
			.filter((rule) => rule.kind === kind)
			.sort((a, b) => a.id - b.id)
			.map((rule) => `${rule.id} ${rule.name} (${rule.kind}): ${rule.value}`),
	);

	return [
		"A rule is what a person of the project said that each agent follows (conduct) or knows as true (domain); only the user puts a rule in effect. Propose a rule with the `rule` tool, and never write a rule into `AGENTS.md`.",
		...lines,
	].join("\n");
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
	const status = isFinished(parley.status) ? ` (${parley.status})` : "";
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
