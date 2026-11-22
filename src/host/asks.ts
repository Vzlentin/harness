/**
 * The asks of the store of the project, by ID: the questions that someone puts to the user, their answers, drops,
 * notes and takes, and their reads, and the handle of the entries to them. An ask keeps the parley that it serves as data
 * from its caller, which this module does not read. The commit of an answer also adds the todos `Save to the vault`,
 * queues the deliveries of the answers for their askers, and queues one event for each answered ask. The plain asks
 * serve the `ask` requests of a host whose entries serve no parley asks.
 */
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type DocumentReader, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import {
	type AnswerAuthor,
	type AnswerInput,
	type Ask,
	type AskList,
	type AskOption,
	type AskRef,
	ASKS_KIND,
	askTransition,
	knownAsk,
} from "../protocol/project.ts";
import {
	type AnswerAuthorOf,
	askGroup,
	type AskRequest,
	type GroupAnswers,
	type Replies,
} from "../protocol/requests.ts";
import { todoLine } from "../protocol/todo.ts";
import { queueAskEvents } from "./ask-events.ts";
import { boundedReplay } from "./checkpoint.ts";
import type { AskAnswer, EntryAsks, NewAsk } from "./entries.ts";
import { addSaveTodos, closeSaveTodo } from "./save-todo.ts";
import { dropAnswers, queueAnswers } from "./user-answers.ts";

/** The error of a request that frames a parley or names an ask by its number in a parley, on a host without parleys. */
const NO_PARLEY_ASKS = "no loaded entry serves parley asks";

const Asks = defineDoc<AskList>({
	kind: ASKS_KIND,
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ asks: [] }),
});

/** An ask in the state `answered`. */
type AnsweredAsk = Extract<Ask, { readonly state: "answered" }>;

/** The fields of an ask without its state and its answer. */
type AskBase = Omit<Extract<Ask, { readonly state: "open" }>, "state">;

/** The asks of the store, as the entries get them. */
export const ENTRY_ASKS: EntryAsks = {
	read: readAsks,
	inCommit: async (tx) => (await tx.doc(Asks)).asks,
	add: addAsks,
	answer: answerAsks,
	drop: dropAsk,
	note: noteAsk,
	take: async (tx, ids, by) => {
		await takeAsks(tx, ids, by);
		await dropAnswers(tx, ids);
	},
	load: async (tx, asks) => {
		(await tx.doc(Asks)).asks.push(...asks);
	},
};

/** Adds an open ask for each of `asks`, asked at `at` by the caller `by`, each with the next ID, and gives them. */
export async function addAsks(tx: Tx, asks: readonly NewAsk[], by: string, at: number): Promise<Ask[]> {
	const list = (await tx.doc(Asks)).asks;
	const written: Ask[] = [];

	for (const { input, parley } of asks) {
		const ask: Ask = { id: (list.at(-1)?.id ?? 0) + 1, title: input.title, state: "open", asker: by, at, by };

		if (input.kind !== undefined) ask.kind = input.kind;

		if (input.tension !== undefined) ask.tension = input.tension;

		if (input.options !== undefined) ask.options = input.options.map(copyOption);

		if (input.plan !== undefined) ask.plan = input.plan;

		if (input.view !== undefined) ask.view = input.view;

		if (parley !== undefined) ask.parley = { ...parley };

		list.push(ask);
		written.push(Value.Clone(ask));
	}

	return written;
}

/**
 * Writes the answers `answers` of `author` for the caller `by`, and gives the answered asks, in the order of
 * `answers`. Two answers of one ask fail. Each answer replaces the answer of its ask, with its label and its words, as
 * one unit. An ask takes `own`, and the key of one of its options. The asks of `confirms` take `own` and `ok`, and get
 * no todo `Save to the vault`. When the host has a vault, the same commit adds the todo `Save to the vault` of each
 * other answered ask to the list of its asker, where `root` is the project agent. It queues the deliveries that `group` makes of the answered asks
 * whose asker is not `by`, and each delivery ends with the line of each added todo of its asks. It also queues one event
 * for each answered ask.
 */
export async function answerAsks(
	tx: Tx,
	answers: readonly AskAnswer[],
	confirms: ReadonlySet<number>,
	by: string,
	author: AnswerAuthor,
	root: ConversationId,
	group: GroupAnswers,
): Promise<Ask[]> {
	const asks = (await tx.doc(Asks)).asks;
	const at = Date.now();
	const written: Ask[] = [];

	for (const input of answers) {
		const ask = knownAsk(asks, input.id);

		if (written.some((each) => each.id === ask.id)) throw new Error(`Ask ${ask.id} has two answers in one write`);

		if (askTransition(ask.state, "answer") === undefined)
			throw new Error(`Ask ${ask.id} is ${ask.state}: it takes no answer`);
		const keys = confirms.has(ask.id) ? ["ok"] : optionKeys(ask);

		if (input.answer !== "own" && !keys.includes(input.answer)) {
			throw new Error(`Ask ${ask.id} takes ${keys.length === 0 ? "own" : `${keys.join(", ")} or own`}`);
		}

		const answered: AnsweredAsk = { ...askBase(ask), state: "answered", answer: input.answer, at, by, author };

		if (input.label !== undefined) answered.label = input.label;

		if (input.words !== undefined) answered.words = [...input.words];
		asks[asks.indexOf(ask)] = answered;
		written.push(Value.Clone(answered));
	}

	const added = await addSaveTodos(
		tx,
		root,
		written.filter((ask) => !confirms.has(ask.id)),
	);

	const deliveries = group(written.filter((ask) => ask.asker !== by)).map(({ asker, asks: ids, delivery }) => {
		const lines = added.filter((todo) => todo.ask !== undefined && ids.includes(todo.ask)).map(todoLine);

		return { asker, delivery: { ...delivery, text: delivery.text + lines.map((line) => `${line}\n`).join("") } };
	});

	await queueAnswers(tx, deliveries);
	await queueAskEvents(tx, written);

	return written;
}

/** Drops the open ask `id` for the caller `by`, and gives it. An ask that is not open fails. */
export async function dropAsk(tx: Tx, id: number, by: string): Promise<Ask> {
	const asks = (await tx.doc(Asks)).asks;
	const ask = knownAsk(asks, id);

	if (askTransition(ask.state, "drop") === undefined)
		throw new Error(`Ask ${ask.id} is ${ask.state}: only an open ask drops`);
	const dropped: Ask = { ...askBase(ask), state: "dropped", at: Date.now(), by };
	asks[asks.indexOf(ask)] = dropped;

	return Value.Clone(dropped);
}

/**
 * Sets `note`, the ID of a note in the vault, on the ask `id` for the caller `by`, and gives the ask. Only the asker of
 * the ask records its note. An ask in any state takes a note, and a second note replaces the first. The note sets the
 * todo `Save to the vault` of the ask to done, unless the asker dropped it.
 */
export async function noteAsk(tx: Tx, id: number, note: string, by: string): Promise<Ask> {
	const ask = knownAsk((await tx.doc(Asks)).asks, id);

	if (ask.asker !== by) throw new Error(`Ask ${ask.id} was asked by another caller: only its asker records its note`);
	Object.assign(ask, { note, at: Date.now(), by });
	await closeSaveTodo(tx, ask);

	return Value.Clone(ask);
}

/** Makes the caller `by` the asker of each open ask of `ids`. An ask that is not open does not change. */
async function takeAsks(tx: Tx, ids: readonly number[], by: string): Promise<void> {
	const at = Date.now();

	for (const ask of (await tx.doc(Asks)).asks) {
		if (ids.includes(ask.id) && ask.state === "open") Object.assign(ask, { asker: by, at, by });
	}
}

/** Every ask, in ID order. */
export async function readAsks(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<AskList> {
	const list = await reader.snapshot(Asks, context);

	return { asks: Value.Clone(list?.asks ?? []) };
}

/** The open asks, in ID order. */
export async function readOpenAsks(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<AskList> {
	return { asks: (await readAsks(reader, context)).asks.filter((ask) => ask.state === "open") };
}

/**
 * Serves `request` with the plain asks, on the store of `harness`, which name each ask by its ID. A round that frames a
 * parley, and an ask by its number in a parley, fail: the plain asks make no parley. An ask that serves a parley is an
 * ask like any other: its `parley` is data. `root` is the project agent, and `authorOf` gives the author of the answers
 * of an `answer`.
 */
export async function plainAsk(
	request: AskRequest,
	harness: Pick<Harness, "commit" | "snapshot">,
	root: ConversationId,
	authorOf: AnswerAuthorOf,
	context: Context,
): Promise<Replies["ask"]> {
	switch (request.action) {
		case "round": {
			if (request.parley !== undefined) throw new Error(NO_PARLEY_ASKS);
			const inputs = request.asks.map((input) => ({ input }));

			return {
				parleys: [],
				asks: await harness.commit((tx) => addAsks(tx, inputs, request.caller, Date.now()), context),
			};
		}

		case "answer": {
			const answers = request.answers.map(plainAnswer);
			const author = await authorOf(request);

			const written = await harness.commit(
				(tx) => answerAsks(tx, answers, new Set(), request.caller, author, root, (answered) => answered.map(askGroup)),
				context,
			);

			return { parleys: [], asks: written };
		}

		case "drop": {
			const id = plainRef(request);
			const dropped = await harness.commit((tx) => dropAsk(tx, id, request.caller), context);

			return { parleys: [], asks: [dropped] };
		}

		case "note":
			return harness.commit((tx) => noteAsk(tx, plainRef(request), request.note, request.caller), context);
		case "read":
			return knownAsk((await readAsks(harness, context)).asks, plainRef(request));
		case "list":
			return readOpenAsks(harness, context);
	}
}

/** The ID of the ask of `ref`. An ask by its number in a parley fails: the plain asks have no parleys. */
function plainRef(ref: AskRef): number {
	if (ref.id === undefined) throw new Error(NO_PARLEY_ASKS);

	return ref.id;
}

/** The answer `input` by ask ID. An answer of an ask by its number in a parley fails: the plain asks have no parleys. */
function plainAnswer(input: AnswerInput): AskAnswer {
	const { slug: _slug, n: _n, ...answer } = input;

	return { ...answer, id: plainRef(input) };
}

/** The fields of `ask` without its state, its answer and the author of its answer. */
function askBase(ask: Ask): AskBase {
	if (ask.state !== "answered") {
		const { state: _state, ...base } = ask;

		return base;
	}

	const { state: _state, author: _author, answer: _answer, label: _label, words: _words, ...base } = ask;

	return base;
}

/** The keys of the options of `ask`. */
function optionKeys(ask: Ask): string[] {
	return ask.options?.map((option) => option.key) ?? [];
}

/** A copy of `option` with only the fields of an option. */
function copyOption(option: AskOption): AskOption {
	const copy: AskOption = { key: option.key, label: option.label };

	if (option.gains !== undefined) copy.gains = [...option.gains];

	if (option.costs !== undefined) copy.costs = [...option.costs];

	return copy;
}
