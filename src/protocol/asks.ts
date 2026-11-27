/**
 * The asks: the questions that a worker puts to the user, their answers, and the parley frame of a round of asks, which
 * harness stores but does not read.
 */
import { type Static, type TProperties, type TSchema, Type } from "typebox";
import { SLUG } from "./paths.ts";

/** The ID of an ask, a parley or a work item: its place in its list, 1, 2, 3 and so on. */
export const LocalId = Type.Integer({ minimum: 1 });

/** The ID of a conversation of the host. */
export const StoreId = Type.Integer({ minimum: 1 });

/** A text with at least one character that is not white space. */
export const Text = Type.String({ pattern: "\\S" });

/** The ID of a note in the vault: the `id` of its front matter, kept as it is given. */
export const NoteId = Text;

/** A time in epoch milliseconds. */
export const Time = Type.Integer({ minimum: 0 });

/** The caller of the request that wrote an object last: the conversation ID of a hosted agent, or a Pi session ID. */
export const Caller = Type.String();

/** The rule of a plain text, as a request error gives it. */
export const PLAIN_RULE = "plain text, no backticks or **";

/**
 * A plain text: at least one character that is not white space, with no backtick and no `**`, as the parley skill
 * checks it.
 */
const Plain = Type.String({ pattern: "^(?![\\s\\S]*(`|\\*\\*))[\\s\\S]*\\S", description: PLAIN_RULE });

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

/** Whether `ask` is the read-back of a parley: an ask of a parley with no options, which the user answers with `ok`. */
export function isReadBack(ask: Ask): boolean {
	return ask.parley !== undefined && ask.options === undefined;
}

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

/** The ask `id` of `asks`. An ID of no ask fails with `Unknown ask: <id>`. */
export function knownAsk<T extends Ask>(asks: readonly T[], id: number): T {
	const ask = asks.find((found) => found.id === id);

	if (ask === undefined) throw new Error(`Unknown ask: ${id}`);

	return ask;
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

/** The fields of each parley, whatever its status. */
export const ParleyFields = {
	id: LocalId,
	slug: Slug,
	title: Plain,
	goal: Plain,
	evidence: Type.Optional(Plains),
	at: Time,
	by: Caller,
};

/**
 * A group of asks with a frame: its slug, unique in the host, its title, its goal, its evidence and its design
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

/**
 * The three objects with `fields` and a round on the wire: one with `parley`, the frame of its parley, `item`, the ID
 * of the item that the parley shapes, when it has one, and one or more asks; one with neither and one or more asks; and
 * one with `parley`, `item` when it has one, and no asks. The second refuses `parley` and `item`, so `item` needs
 * `parley`. The round with no asks comes last, so a request that fails names the field of the other two first: a bare
 * round with no asks fails on its asks, not on a missing `parley`.
 */
export function withRoundFrame<F extends TProperties>(fields: F) {
	const absent = Type.Optional(Type.Never());
	const asks = Type.Array(AskInput, { minItems: 1 });

	const withFrame = <A extends TSchema>(frameAsks: A) =>
		Type.Object({ ...fields, parley: ParleyFrame, item: Type.Optional(LocalId), asks: frameAsks });

	const framed = withFrame(asks);
	const bare = Type.Object({ ...fields, asks, parley: absent, item: absent });
	const reframed = withFrame(Type.Array(AskInput, { maxItems: 0 }));

	const branches: [typeof framed, typeof bare, typeof reframed] = [framed, bare, reframed];

	return branches;
}

/**
 * The input of a round: the frame of its parley and the item that the parley shapes, when it has them, and its asks:
 * zero or more with a frame, one or more without.
 */
export const AskRound = Type.Union(withRoundFrame({}));

export type AskRound = Static<typeof AskRound>;

/** The kind of the document of the asks in the store. */
export const ASKS_KIND = "harness.asks";

export const AskList = Type.Object({ asks: Type.Array(Ask) });

export type AskList = Static<typeof AskList>;

/** A parley and its asks, in the order of their numbers. */
export const ParleyAsks = Type.Object({ parley: Parley, asks: Type.Array(Ask) });

export type ParleyAsks = Static<typeof ParleyAsks>;

/** A work item that a write of asks added, as its ID and its title. */
export const AddedItem = Type.Object({ id: LocalId, title: Text });

export type AddedItem = Static<typeof AddedItem>;

/**
 * The reply of a write of asks, from the commit of the write: each parley that it changed or whose asks it changed,
 * with all of its asks, in ID order, and the asks with no parley that it added or changed, in ID order. `items` are the
 * work items that the write added, in ID order, and only a write that added items has it.
 */
export const AskWrite = Type.Object({
	parleys: Type.Array(ParleyAsks),
	asks: Type.Array(Ask),
	items: Type.Optional(Type.Array(AddedItem)),
});

export type AskWrite = Static<typeof AskWrite>;

/** The fields of a line of a parley or an ask, joined with ` · `. */
function fieldsText(fields: readonly (string | number | undefined)[]): string {
	return fields.filter((field) => field !== undefined).join(" · ");
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
