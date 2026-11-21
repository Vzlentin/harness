/**
 * The changes of the work items of the store of the project, each in the commit that a caller gives: the `item`
 * request changes them with these functions, each change in its own commit. A round of asks writes the `shapes` edge of its parley, and the commit
 * that makes a parley a contract gives it an item when it shapes none. A load of a store file writes its items, with their
 * edges and the counter. It also gives whether a run is live: the stage of an item reads it,
 * and a live run, or a live task with the label of the item, refuses a change of the item to `done`. A change of an item to `done` or `dropped` ends each contract
 * that shapes it and no open item, and the end of a contract reads the open items that it shapes. A report of a commit
 * by a worker of an item writes its `landed` edge and sets the item `done`, with no refusal for a live run.
 */
import type { Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import {
	CommitRef,
	type Edge,
	type EdgeInput,
	type EdgeItem,
	edgeItem,
	type ItemAdd,
	type ItemSet,
	type ItemState,
	refParts,
	type WorkItem,
} from "../protocol/item.ts";
import type { Ask, Parley } from "../protocol/project.ts";
import type { Worker } from "../protocol/worker-labels.ts";
import { Asks } from "./asks.ts";
import { ItemCounterDoc, itemEnds, Items } from "./item-docs.ts";
import type { ItemIndex } from "./item-index.ts";
import { endContract, knownParley, Parleys } from "./project-docs.ts";
import { labelledTasks, StartedTasks, TaskLabels, taskWorker } from "./tasks.ts";

/** The `start` key `wf:<runId>#<n>` of a task of a run, as workflows writes it: `n` is an integer from 1. */
const RUN_TASK_KEY = /^wf:(.+)#[1-9]\d*$/;

/** Adds an open item with no edge for the caller `by`, with the ID after `last` of the counter, and gives it. */
export async function addItem(tx: Tx, input: ItemAdd, by: string): Promise<WorkItem> {
	const counter = await tx.doc(ItemCounterDoc);
	counter.last += 1;
	const item: WorkItem = { id: counter.last, title: input.title, state: "open", edges: [], at: Date.now(), by };

	if (input.text !== undefined) item.text = input.text;
	// The new document starts as a copy of the seed.
	await tx.doc(Items, String(item.id), item);

	return item;
}

/**
 * Writes `items`, each with its edges, into a store that has no item, in `tx`. `last` of the counter becomes the highest
 * of `last`, the `last` of the store, and the highest ID of `items`, so a new item never takes the ID of a stored one.
 */
export async function loadItems(tx: Tx, items: readonly WorkItem[], last: number): Promise<void> {
	const counter = await tx.doc(ItemCounterDoc);
	counter.last = Math.max(counter.last, last, ...items.map((item) => item.id));

	// Each new document starts as a copy of its seed.
	for (const item of items) await tx.doc(Items, String(item.id), item);
}

/**
 * Changes the fields that `change` gives of the item `change.id` for the caller `by`, and gives the item and the slugs of
 * the contracts that the change ended. A change to `done` fails while a run or a task that serves the item is live. A
 * change to `done` or `dropped` ends each contract that shapes the item and no open item: `done` when one item that it
 * shapes is done, else `dropped`. `items` gives the items that a contract shapes.
 */
export async function setItem(
	tx: Tx,
	change: ItemSet,
	by: string,
	items: Pick<ItemIndex, "itemsOf">,
): Promise<{ readonly item: WorkItem; readonly ended: readonly string[] }> {
	const item = await itemDraft(tx, change.id);

	if (change.state === "done") await refuseLiveRun(tx, item);

	if (change.title !== undefined) item.title = change.title;

	if (change.text !== undefined) item.text = change.text;
	const ended = await changeItem(tx, item, change.state, by, items);

	return { item: Value.Clone(item), ended };
}

/**
 * Writes the edge `item:<id> landed <commit>` for the caller `by`, for each item of `ids`, which the store has, and each
 * commit reference of `refs`, as a report of a worker of the item gives them, and sets each open item of them `done`.
 * A closed item keeps its state. Unlike `setItem`, a live run or task of the item does not refuse the change: the
 * reporter is such a task. `items` gives the items that a contract shapes. It gives the IDs of the items that it set
 * `done`, and the slugs of the contracts that it ended. With no commit reference, it changes nothing.
 */
export async function landCommits(
	tx: Tx,
	ids: readonly number[],
	refs: readonly string[],
	by: string,
	items: Pick<ItemIndex, "itemsOf">,
): Promise<{ readonly done: readonly number[]; readonly ended: readonly string[] }> {
	const commits = refs.filter((ref) => Value.Check(CommitRef, ref));
	const done: number[] = [];
	const ended: string[] = [];

	if (commits.length === 0) return { done, ended };

	for (const id of ids) {
		for (const commit of commits) await writeEdge(tx, { from: `item:${id}`, kind: "landed", to: commit }, by);
		const item = await itemDraft(tx, id);

		if (item.state !== "open") continue;
		ended.push(...(await changeItem(tx, item, "done", by, items)));
		done.push(id);
	}

	return { done, ended };
}

/**
 * The drafts of the items that the contract `slug` shapes in `tx`, in the order of `items`. `items` gives the items with
 * an edge from the parley, and an item counts only while its document still has the edge `shapes`.
 */
export async function contractItems(tx: Tx, slug: string, items: Pick<ItemIndex, "itemsOf">): Promise<WorkItem[]> {
	const end = `parley:${slug}`;
	const work: WorkItem[] = [];

	for (const id of items.itemsOf(end)) {
		const item = await itemDraft(tx, id);

		if (item.edges.some((edge) => edge.from === end && edge.kind === "shapes")) work.push(item);
	}

	return work;
}

/**
 * Checks the edge `input` and writes it into the document of its item for the caller `by`, and gives it, as the request
 * `item link` does. On top of the checks of `writeEdge`, an agent has no `serves` edge, and a run serves one item at
 * most: `items` gives the items of the run.
 */
export async function linkItem(tx: Tx, input: EdgeInput, by: string, items: Pick<ItemIndex, "itemsOf">): Promise<Edge> {
	if (input.kind === "serves") {
		const { id, other } = endsOf(input);
		const item = await itemDraft(tx, id);
		const fresh = !item.edges.some((edge) => sameEdge(edge, input));

		// A stored edge is the reply, and a closed item fails in `writeEdge` with its state: both come before the refusal.
		if (fresh && item.state === "open") refuseServe(other, items);
	}

	return writeEdge(tx, input, by);
}

/**
 * Checks the edge `input` and writes it into the document of its item for the caller `by`, and gives it. The kind fixes
 * the ends, a `needs` edge does not go from an item to itself, the item must exist, and an edge with the same ends and
 * kind is not written again: its stored edge is the reply. A `serves`, `shapes` or `needs` edge needs an open item, a
 * parley at the other end of a `shapes` edge, and an item at the other end of a `needs` edge, which must not make a
 * cycle of `needs` edges: `knownEnd` checks the other end. A run or a commit end is checked for its form only.
 */
export async function writeEdge(tx: Tx, input: EdgeInput, by: string): Promise<Edge> {
	const { id, other } = endsOf(input);
	const item = await itemDraft(tx, id);
	const stored = item.edges.find((edge) => sameEdge(edge, input));

	if (stored !== undefined) return Value.Clone(stored);

	if (input.kind !== "landed" && item.state !== "open") {
		const way = input.from === `item:${id}` ? "go from" : "go to";
		throw new Error(`Item ${id} is ${item.state}: an edge ${input.kind} cannot ${way} it`);
	}

	await knownEnd(tx, id, other);
	const edge: Edge = { from: input.from, kind: input.kind, to: input.to, at: Date.now(), by };
	item.edges.push({ ...edge });

	return edge;
}

/**
 * Gives the contract `parley` an item in `tx` for the caller `by`: when `items` gives no item with the edge
 * `parley:<slug> shapes`, it adds an item with the title of the parley and writes that edge.
 */
export async function itemForContract(
	tx: Tx,
	parley: Readonly<Parley>,
	by: string,
	items: Pick<ItemIndex, "itemsOf">,
): Promise<void> {
	const end = `parley:${parley.slug}`;

	if (items.itemsOf(end).length > 0) return;
	const item = await addItem(tx, { title: parley.title }, by);
	await writeEdge(tx, { from: end, kind: "shapes", to: `item:${item.id}` }, by);
}

/** Removes the edge `input` from the document of its item, and gives the item. The item keeps its `at` and `by`. */
export async function unlinkItem(tx: Tx, input: EdgeInput): Promise<WorkItem> {
	const { id } = endsOf(input);
	const item = await itemDraft(tx, id);
	const index = item.edges.findIndex((edge) => sameEdge(edge, input));

	if (index === -1) throw new Error(`Item ${id} has no edge ${input.from} ${input.kind} ${input.to}`);
	item.edges.splice(index, 1);

	return Value.Clone(item);
}

/** The asker of the asks of the run `runId`, as workflows writes them. */
export function runAsker(runId: string): string {
	return `workflows:${runId}`;
}

/**
 * Whether the run `runId` is live: an ask of `asks` with the asker `runAsker(runId)` is open, as while the run waits for
 * an input of the user, or a task of `workers`, the live workers of a label, has a key `wf:<runId>#<n>`.
 */
export function runLive(runId: string, workers: readonly Worker[], asks: readonly Ask[]): boolean {
	const asker = runAsker(runId);

	if (asks.some((ask) => ask.state === "open" && ask.asker === asker)) return true;

	return workers.some((worker) => worker.kind === "task" && taskRun(worker.key) === runId);
}

/** The run ID of the task whose `start` key is `key`, `wf:<runId>#<n>`, and nothing for a key of another form. */
export function taskRun(key: string): string | undefined {
	return RUN_TASK_KEY.exec(key)?.[1];
}

/**
 * Fails when a run or a task with the label `item:<id>` of `item` is live in `tx`, and names the first one: the runs of
 * the started tasks with the label, in any state of the task, then the live tasks with the label whose key is of another
 * form. A run (`wf:<runId>#<n>`) is live while a live task with the label is a task of the run, or while an ask of the
 * run is open.
 */
async function refuseLiveRun(tx: Tx, item: WorkItem): Promise<void> {
	const keys = labelledTasks((await tx.doc(TaskLabels)).labels, `item:${item.id}`);

	if (keys.length === 0) return;
	const started = await tx.doc(StartedTasks);
	const workers: Worker[] = [];

	for (const key of keys) {
		const worker = await taskWorker(started, key, (id) => tx.task(id));

		if (worker !== undefined) workers.push(worker);
	}

	const { asks } = await tx.doc(Asks);
	const refused = (worker: string) => new Error(`Item ${item.id} cannot be done: ${worker} serves it and is live`);

	for (const run of new Set(keys.flatMap((key) => taskRun(key) ?? []))) {
		if (runLive(run, workers, asks)) throw refused(`run ${run}`);
	}

	const task = workers.find((worker) => worker.kind === "task" && taskRun(worker.key) === undefined);

	if (task?.kind === "task") throw refused(`task ${task.key}`);
}

/**
 * Sets the state of `item` to `state`, when it gives one, and its `at` and `by` for the caller `by`. A change to `done`
 * or `dropped` ends each contract that shapes the item and no open item (`endContracts`), and it gives their slugs.
 */
async function changeItem(
	tx: Tx,
	item: WorkItem,
	state: ItemState | undefined,
	by: string,
	items: Pick<ItemIndex, "itemsOf">,
): Promise<string[]> {
	if (state !== undefined) item.state = state;
	item.at = Date.now();
	item.by = by;

	return state === "done" || state === "dropped" ? endContracts(tx, item, by, items) : [];
}

/**
 * Ends each contract with an edge to `item`, a closed item, for the caller `by` when the contract shapes no open item:
 * `done` when one item that it shapes is done, else `dropped`. `items` gives the items that a contract shapes. It gives
 * the slugs of the contracts that it ended.
 */
async function endContracts(tx: Tx, item: WorkItem, by: string, items: Pick<ItemIndex, "itemsOf">): Promise<string[]> {
	const { parleys: slugs } = itemEnds(item);

	if (slugs.length === 0) return [];
	const parleys = (await tx.doc(Parleys)).parleys;
	const ended: string[] = [];

	for (const slug of new Set(slugs)) {
		const parley = parleys.find((found) => found.slug === slug);

		if (parley?.status !== "contract") continue;
		const work = await contractItems(tx, slug, items);

		if (work.some((found) => found.state === "open")) continue;
		endContract(parleys, parley, work.some((found) => found.state === "done") ? "done" : "dropped", by);
		ended.push(slug);
	}

	return ended;
}

/** The `at` of the seed of a missing item, which no stored item has. */
const MISSING_AT = -1;

/**
 * The draft of the item `id` in `tx`. An ID with no item, such as an ID that no `item add` gave or the ID of a todo
 * that the move to items did not move, fails with `Unknown item: <id>`.
 */
async function itemDraft(tx: Tx, id: number): Promise<WorkItem> {
	// `tx.doc` creates a missing item from this seed, and the throw fails the commit, so the seed is never stored.
	const seed: WorkItem = { id, title: "-", state: "open", edges: [], at: MISSING_AT, by: "" };
	const item = await tx.doc(Items, String(id), seed);

	if (item.at === MISSING_AT) throw new Error(`Unknown item: ${id}`);

	return item;
}

/**
 * The ID of the item that stores `edge`, and the reference at its other end. Ends that its kind does not take fail, and
 * so does an edge from an item to itself.
 */
function endsOf(edge: EdgeInput): EdgeItem {
	const ends = edgeItem(edge);

	if (ends === undefined) throw new Error(`An edge ${edge.kind} cannot go from ${edge.from} to ${edge.to}`);

	if (edge.from === edge.to) throw new Error(`An edge ${edge.kind} cannot go from ${edge.from} to itself`);

	return ends;
}

/**
 * Fails when `ref`, the end of an edge that the item `id` stores and that is not that item, is a parley that the store
 * does not have, or an item that the store does not have or that needs the item `id`, so that the edge would make a
 * cycle of `needs` edges. A run or a commit is not checked.
 */
async function knownEnd(tx: Tx, id: number, ref: string): Promise<void> {
	const { kind, value } = refParts(ref);

	if (kind === "parley") knownParley((await tx.doc(Parleys)).parleys, value);
	else if (kind === "item") await refuseCycle(tx, id, Number(value));
}

/**
 * Fails when the item `to` needs the item `from`, through its `needs` edges and those of the items it needs, so that the
 * edge `item:<from> needs item:<to>` would make a cycle. The walk only reads the items, so the commit writes none of them.
 */
async function refuseCycle(tx: Tx, from: number, to: number): Promise<void> {
	const seen = new Set([to]);
	const next = [to];

	for (let id = next.pop(); id !== undefined; id = next.pop()) {
		for (const edge of (await itemDraft(tx, id)).edges) {
			if (edge.kind !== "needs") continue;
			const needed = Number(refParts(edge.to).value);

			if (needed === from) throw new Error(`Item ${to} already needs item ${from}: an edge needs cannot make a cycle`);

			if (!seen.has(needed)) {
				seen.add(needed);
				next.push(needed);
			}
		}
	}
}

/**
 * Fails when `from`, the end of a new `serves` edge of `item link`, cannot write it: an agent, which serves an item
 * through its label, or a run that `items` gives an item for.
 */
function refuseServe(from: string, items: Pick<ItemIndex, "itemsOf">): void {
	const { kind, value } = refParts(from);

	if (kind === "agent") throw new Error("An agent serves an item through its label: spawn it with serves");
	const served = items.itemsOf(from)[0];

	if (served !== undefined) throw new Error(`Run ${value} already serves item ${served}`);
}

/** Whether `edge` has the ends and the kind of `input`. */
function sameEdge(edge: Edge, input: EdgeInput): boolean {
	return edge.from === input.from && edge.kind === input.kind && edge.to === input.to;
}
