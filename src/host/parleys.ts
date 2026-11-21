/**
 * The parleys of the store of the project, on top of the asks of `asks.ts`: a round frames a parley and numbers its
 * asks, an ask on the wire names its ask by ID or by its number in a parley, and the reply of a write gives each parley
 * that it touched with all of its asks. An answer groups the deliveries of a parley, and refuses the read-back `ok` of a
 * parley that cannot be a contract. The contract comes after the answer: `parleyReaction` makes it from the event of the
 * answered read-back, and gives it an item. A round and a contract also write the `shapes` edge of their parley to a
 * work item, and a contract that shapes an open item does not end.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, Harness, Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import {
	type AnswerAuthor,
	type AnswerInput,
	type Ask,
	type AskRef,
	type AskRound,
	type AskWrite,
	isReadBack,
	type Parley,
	type ParleyAsks,
	type ParleyEnd,
	type ParleyFrame,
	type ParleyList,
	parleyText,
} from "../protocol/project.ts";
import {
	type AnswerGroup,
	answerAsks,
	askGroup,
	Asks,
	addAsks,
	dropAsk,
	knownAsk,
	noteAsk,
	readAsks,
	takeAsks,
} from "./asks.ts";
import type { AnsweredAskHandler } from "./entries.ts";
import type { ItemIndex } from "./item-index.ts";
import { contractItems, itemForContract, writeEdge } from "./items.ts";
import { endContract, known, knownParley, Parleys } from "./project-docs.ts";
import { dropAnswers } from "./user-answers.ts";

const context = BACKGROUND_CONTEXT;

/** A parley in the status `open`. */
type OpenParley = Extract<Parley, { readonly status: "open" }>;

/**
 * Writes the round `round` with the caller `by` as the asker of its asks, and gives the write: the parley with all of
 * its asks, or the new asks when they have no parley. With `round.parley`, a new slug makes an open parley, which needs
 * a title and a goal, and a known slug must be an open parley, whose fields the frame replaces. A round with no asks
 * must change a field of a known open parley. With `round.item`, the round also writes the edge
 * `parley:<slug> shapes item:<item>` with the checks of `item link`. The asks of a parley take the next numbers of that
 * parley.
 */
export async function writeRound(tx: Tx, round: AskRound, by: string): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const at = Date.now();

	const parley =
		round.parley === undefined
			? undefined
			: frameParley(parleys, round.parley, { at, by, reframe: round.asks.length === 0 });

	if (parley !== undefined && round.item !== undefined) {
		await writeEdge(tx, { from: `parley:${parley.slug}`, kind: "shapes", to: `item:${round.item}` }, by);
	}

	const n = parley === undefined ? 0 : lastNumber((await tx.doc(Asks)).asks, parley.id);

	const written = await addAsks(
		tx,
		round.asks.map((input, index) =>
			parley === undefined ? { input } : { input, parley: { id: parley.id, n: n + index + 1 } },
		),
		by,
		at,
	);

	return writeReply(tx, parley === undefined ? [] : [parley.id], written);
}

/**
 * Writes the answers `answers` of `author` for the caller `by`, as `answerAsks` writes them, and gives the write: each
 * parley of the answered asks, with all of its asks, and the answered asks with no parley. Each answer names its ask by
 * ID, or by its number in a parley, which must be open. The answer `ok` to the read-back of a parley, an ask of the
 * parley with no options, needs a parley that can be a contract once every answer is written: each other ask of the
 * parley is answered or dropped, and its `design_sense` is set. The parley stays open: its event makes the contract.
 * The answers go to their askers in one delivery for each asker and parley, with the text of the parley, and one for
 * each answered ask with no parley. `root` is the project agent.
 */
export async function writeAnswers(
	tx: Tx,
	answers: readonly AnswerInput[],
	by: string,
	author: AnswerAuthor,
	root: ConversationId,
): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const asks = (await tx.doc(Asks)).asks;
	const readBacks = new Set<number>();
	const confirms = new Set<number>();

	const byId = answers.map((input) => {
		const ask = resolveAsk(parleys, asks, input);

		if (ask.parley !== undefined) openParley(known(parleys, ask.parley.id, "parley"));

		if (ask.parley !== undefined && isReadBack(ask)) {
			confirms.add(ask.id);

			if (input.answer === "ok") readBacks.add(ask.parley.id);
		}

		const { slug: _slug, n: _n, ...answer } = input;

		return { ...answer, id: ask.id };
	});

	const written = await answerAsks(tx, byId, confirms, by, author, root, (answered) =>
		groupAnswers(parleys, asks, answered),
	);

	for (const id of readBacks) {
		const signed = signContract(known(parleys, id, "parley"), asks, by, Date.now());

		if ("refusal" in signed) throw new Error(signed.refusal);
	}

	return writeReply(tx, parleyIds(written), written);
}

/**
 * Drops the open ask of `ref` for the caller `by`, and gives the write: its parley with all of its asks, or the ask
 * when it has no parley. The ask of a parley that is not open does not change.
 */
export async function dropAskRef(tx: Tx, ref: AskRef, by: string): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const ask = resolveAsk(parleys, (await tx.doc(Asks)).asks, ref);

	if (ask.parley !== undefined) openParley(known(parleys, ask.parley.id, "parley"));
	const dropped = await dropAsk(tx, ask.id, by);

	return writeReply(tx, parleyIds([dropped]), [dropped]);
}

/**
 * Sets `note` on the ask of `ref` for the caller `by`, as `noteAsk` does, and gives the ask. An ask of a parley that is
 * not open also takes a note.
 */
export async function noteAskRef(tx: Tx, ref: AskRef, note: string, by: string): Promise<Ask> {
	const ask = resolveAsk((await tx.doc(Parleys)).parleys, (await tx.doc(Asks)).asks, ref);

	return noteAsk(tx, ask.id, note, by);
}

/**
 * Makes the caller `by` the asker of the open asks of the parley `slug`, and gives the parley and its asks. The parley
 * is open or a contract: a contract has no open ask, so its take changes no ask. The answers of the parley that wait in
 * the queue go: the reply has them, and no asker gets them after the take.
 */
export async function takeParley(tx: Tx, slug: string, by: string): Promise<ParleyAsks> {
	const parley = knownParley((await tx.doc(Parleys)).parleys, slug);

	if (parley.status !== "contract") openParley(parley);
	const asks = (await tx.doc(Asks)).asks;
	const ids = parleyAsks(asks, parley.id).map((ask) => ask.id);
	await takeAsks(tx, ids, by);
	await dropAnswers(tx, ids);

	return { parley: Value.Clone(parley), asks: parleyAsks(asks, parley.id) };
}

/**
 * Ends the contract `slug` with the status `status` for the caller `by`, and gives the parley. A contract that shapes
 * an open item fails: the close of its last item ends it. `items` gives the items that the contract shapes.
 */
export async function endParley(
	tx: Tx,
	slug: string,
	status: ParleyEnd,
	by: string,
	items: Pick<ItemIndex, "itemsOf">,
): Promise<Parley> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const parley = knownParley(parleys, slug);

	if (parley.status !== "contract") throw new Error(`Parley ${slug} is ${parley.status}: only a contract ends`);
	const work = await contractItems(tx, slug, items);
	const open = work.filter((item) => item.state === "open").map((item) => item.id);

	if (open.length > 0) {
		throw new Error(`Parley ${slug} shapes open items ${open.join(", ")}: close them, and the contract ends`);
	}

	return endContract(parleys, parley, status, by);
}

/** The parleys, in ID order. */
export async function readParleys(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<ParleyList> {
	const list = await reader.snapshot(Parleys, context);

	return { parleys: Value.Clone(list?.parleys ?? []) };
}

/** The ask of `ref`, in any state. */
export async function readAsk(reader: Pick<DocumentReader, "snapshot">, ref: AskRef, context: Context): Promise<Ask> {
	const { parleys } = await readParleys(reader, context);

	return resolveAsk(parleys, (await readAsks(reader, context)).asks, ref);
}

/** The parley `slug` and its asks, in the order of their numbers. */
export async function readParley(
	reader: Pick<DocumentReader, "snapshot">,
	slug: string,
	context: Context,
): Promise<ParleyAsks> {
	const parley = knownParley((await readParleys(reader, context)).parleys, slug);

	return { parley, asks: parleyAsks((await readAsks(reader, context)).asks, parley.id) };
}

/** What the reaction to the answered read-backs uses of the host. */
export type ParleyReactionHost = {
	readonly harness: Pick<Harness, "commit">;
	readonly items: Pick<ItemIndex, "itemsOf">;
	readonly warn: (cause: unknown) => void;
};

/**
 * The handler of the answered asks that makes the contracts: for the read-back of a parley answered `ok`, it makes the
 * parley a contract in one commit, with the answerer as its `by`, and gives it an item when it shapes none. It reads the
 * state at that time: a parley that is not open, and a read-back that is no longer answered `ok`, change nothing, so a
 * second event of the same answer does nothing. A parley that cannot be a contract at that time is a warning.
 */
export function parleyReaction({ harness, items, warn }: ParleyReactionHost): AnsweredAskHandler {
	return async ({ ask }) => {
		if (ask.parley === undefined || !isReadBack(ask)) return;
		const { id } = ask.parley;

		const refusal = await harness.commit(async (tx) => {
			const parleys = (await tx.doc(Parleys)).parleys;
			const parley = parleys.find((found) => found.id === id);

			if (parley?.status !== "open") return undefined;
			const asks = (await tx.doc(Asks)).asks;
			const current = asks.find((found) => found.id === ask.id);

			if (current?.state !== "answered" || current.answer !== "ok") return undefined;
			const signed = signContract(parley, asks, current.by, Date.now());

			if ("refusal" in signed) return signed.refusal;
			parleys[parleys.indexOf(parley)] = signed.contract;
			await itemForContract(tx, signed.contract, current.by, items);

			return undefined;
		}, context);

		if (refusal !== undefined) warn(new Error(refusal));
	};
}

/**
 * The parley `parley` as a contract with the asks `asks`, at the time `at` for the caller `by`, or why it cannot be one:
 * its `design_sense` is not set, or one of its asks is open.
 */
function signContract(
	parley: Parley,
	asks: readonly Ask[],
	by: string,
	at: number,
): { contract: Parley } | { refusal: string } {
	if (parley.design_sense === undefined)
		return { refusal: `Parley ${parley.slug} cannot be a contract: design_sense is not set` };
	const open = asks.find((ask) => ask.parley?.id === parley.id && ask.state === "open");

	if (open?.parley !== undefined)
		return { refusal: `Parley ${parley.slug} cannot be a contract: ask ${open.parley.n} is open` };

	return { contract: { ...parley, status: "contract", design_sense: parley.design_sense, at, by } };
}

/**
 * The deliveries of the answered asks `answered`, in their order: one for each asker and parley, with the text of the
 * parley in `parleys` and `asks`, and one for each ask with no parley.
 */
function groupAnswers(parleys: readonly Parley[], asks: readonly Ask[], answered: readonly Ask[]): AnswerGroup[] {
	const groups: AnswerGroup[] = [];
	const byParley = new Map<string, number[]>();

	for (const ask of answered) {
		if (ask.parley === undefined) {
			groups.push(askGroup(ask));
			continue;
		}

		const key = `${ask.asker}\n${ask.parley.id}`;
		const found = byParley.get(key);

		if (found !== undefined) {
			found.push(ask.id);
			continue;
		}

		const parley = known(parleys, ask.parley.id, "parley");
		const text = parleyText({ parley, asks: parleyAsks(asks, parley.id) });
		const ids = [ask.id];
		byParley.set(key, ids);
		groups.push({ asker: ask.asker, asks: ids, delivery: { source: "parley", parley: parley.slug, asks: ids, text } });
	}

	return groups;
}

/**
 * The reply of a write: each parley of `ids`, once, in ID order, with all of its asks, and the asks of `written` with
 * no parley.
 */
async function writeReply(tx: Tx, ids: readonly number[], written: readonly Ask[]): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const asks = (await tx.doc(Asks)).asks;
	const changed = [...new Set(ids)].sort((a, b) => a - b);

	return {
		parleys: changed.map((id) => ({ parley: Value.Clone(known(parleys, id, "parley")), asks: parleyAsks(asks, id) })),
		asks: written.filter((ask) => ask.parley === undefined),
	};
}

/** The IDs of the parleys of `asks`. */
function parleyIds(asks: readonly Ask[]): number[] {
	return asks.flatMap((ask) => (ask.parley === undefined ? [] : [ask.parley.id]));
}

/** The fields of a parley that a frame sets: its title, goal, evidence and design sense. */
function framedFields(parley: OpenParley): readonly unknown[] {
	return [parley.title, parley.goal, parley.evidence, parley.design_sense];
}

/**
 * The open parley of the frame `frame`, written at `at` by the caller `by`: a new parley for a new slug, or the known
 * parley with the fields of the frame. With `reframe`, the round has no asks: the frame must name an open parley of
 * `parleys` and change its title, goal, evidence or design sense.
 */
function frameParley(
	parleys: Parley[],
	frame: ParleyFrame,
	{ at, by, reframe }: { readonly at: number; readonly by: string; readonly reframe: boolean },
): OpenParley {
	const { slug } = frame;
	const existing = parleys.find((parley) => parley.slug === slug);
	const unchanged = `A round with no asks must change the title, goal, evidence or design sense of the open parley ${slug}`;

	if (reframe && existing?.status !== "open") throw new Error(unchanged);
	const found = existing === undefined ? undefined : openParley(existing);
	const title = frame.title ?? found?.title;
	const goal = frame.goal ?? found?.goal;

	if (title === undefined) throw new Error(`Parley ${slug} is new: title is required`);

	if (goal === undefined) throw new Error(`Parley ${slug} is new: goal is required`);
	const id = found?.id ?? (parleys.at(-1)?.id ?? 0) + 1;
	const parley: OpenParley = { id, slug, title, goal, status: "open", at, by };
	const evidence = frame.evidence ?? found?.evidence;
	const designSense = frame.design_sense ?? found?.design_sense;

	if (evidence !== undefined) parley.evidence = [...evidence];

	if (designSense !== undefined) parley.design_sense = designSense;

	if (reframe && found !== undefined && Value.Equal(framedFields(parley), framedFields(found))) {
		throw new Error(unchanged);
	}

	if (found === undefined) parleys.push(parley);
	else parleys[parleys.indexOf(found)] = parley;

	return Value.Clone(parley);
}

/** `parley` when it is open. A parley in another status fails: its asks do not change. */
function openParley(parley: Parley): OpenParley {
	if (parley.status !== "open") throw new Error(`Parley ${parley.slug} is ${parley.status}: its asks do not change`);

	return parley;
}

/** The ask of `ref` in `asks`: the ask of its ID, or the ask of its number in its parley. */
function resolveAsk<T extends Ask>(parleys: readonly Parley[], asks: readonly T[], ref: AskRef): T {
	if (ref.id !== undefined) return knownAsk(asks, ref.id);
	const parley = knownParley(parleys, ref.slug);
	const ask = asks.find((found) => found.parley?.id === parley.id && found.parley.n === ref.n);

	if (ask === undefined) throw new Error(`Parley ${parley.slug} has no ask ${ref.n}`);

	return ask;
}

/** The highest number of the asks of the parley `id`, or 0 when it has none. */
function lastNumber(asks: readonly Ask[], id: number): number {
	return Math.max(0, ...asks.flatMap((ask) => (ask.parley?.id === id ? [ask.parley.n] : [])));
}

/** Copies of the asks of the parley `id`, in the order of their numbers. */
function parleyAsks(asks: readonly Ask[], id: number): Ask[] {
	return asks.flatMap((ask) => (ask.parley?.id === id ? [Value.Clone(ask)] : []));
}
