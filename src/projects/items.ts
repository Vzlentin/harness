/**
 * The changes of the work items of the project store, each in the write that a caller gives: the `item` request changes
 * them with these functions, each change in its own write. A round of asks writes the `shapes` edge of its parley, and
 * the write that makes a parley a contract gives it an item when it shapes none. It also gives the other ends of the
 * edges of an item, the item with the `needs` edges that go to it, and whether a run is live: the stage of an item reads
 * it, and a live run, or a live task with the label of the item, refuses a change of the item to `done`. A change of an
 * item to `done` or `dropped` ends each contract that shapes it and no open item, and the end of a contract reads the
 * open items that it shapes. A report of a commit by a worker of an item writes its `landed` edge and sets the item
 * `done`, with no refusal for a live run.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { EntryHandles } from "../host/entries.ts";
import {
	CommitRef,
	type Edge,
	type EdgeInput,
	type EdgeItem,
	type ItemAdd,
	type ItemSet,
	type ItemState,
	refParts,
	type WorkItem,
} from "../protocol/item.ts";
import type { Ask, Parley, ParleyEnd } from "../protocol/project.ts";
import type { Worker } from "../protocol/worker-labels.ts";
import { edgeEnds, type StoreReader, type StoreTx } from "./project-store.ts";

const context = BACKGROUND_CONTEXT;

/** The `start` key `wf:<runId>#<n>` of a task of a run, as workflows writes it: `n` is an integer from 1. */
const RUN_TASK_KEY = /^wf:(.+)#[1-9]\d*$/;

/**
 * What a change of an item to `done` reads of the host before its write: the keys of the started tasks with the label
 * of the item, in any state, the live workers of that label, and the open asks.
 */
export type ItemWorkers = {
	readonly tasks: readonly string[];
	readonly workers: readonly Worker[];
	readonly asks: readonly Ask[];
};

/** What the read of the workers of an item uses of the host. */
export type ItemWorkersHost = Pick<EntryHandles, "labelledTasks" | "workers" | "asks"> & {
	readonly harness: Pick<DocumentReader, "snapshot">;
};

/** The workers of the item `id`, as the host has them now. */
export async function readItemWorkers(host: ItemWorkersHost, id: number): Promise<ItemWorkers> {
	const label = `item:${id}`;

	const [tasks, workers, { asks }] = await Promise.all([
		host.labelledTasks(),
		host.workers(label),
		host.asks.open(host.harness, context),
	]);

	return { tasks: tasks.get(label) ?? [], workers, asks };
}

/**
 * The item `id`, in any state, with its edges and then the `needs` edges that go to it from other items, in the ID order
 * of those items. Only the item that needs another stores the edge.
 */
export function readItemBothWays(store: Pick<StoreReader, "item" | "incomingNeeds">, id: number): WorkItem {
	const item = store.item(id);

	return { ...item, edges: [...item.edges, ...store.incomingNeeds(id)] };
}

/** The other ends of the `serves` and `shapes` edges of an item, without their kinds, in the order of the edges. */
export type ItemEnds = {
	/** The IDs of the runs that serve the item. */
	readonly runs: readonly string[];
	/** The slugs of the parleys that shape the item. */
	readonly parleys: readonly string[];
};

/** The other ends of the `serves` and `shapes` edges of `item`. */
export function itemEnds(item: Readonly<WorkItem>): ItemEnds {
	const runs: string[] = [];
	const parleys: string[] = [];

	for (const edge of item.edges) {
		const { kind, value } = refParts(edge.from);

		if (kind === "run") runs.push(value);
		else if (kind === "parley") parleys.push(value);
	}

	return { runs, parleys };
}

/** Adds an open item with no edge for the caller `by`, with the next ID, and gives it. */
export function addItem(tx: StoreTx, input: ItemAdd, by: string): WorkItem {
	const item = { title: input.title, state: "open", at: Date.now(), by } as const;

	return tx.addItem(input.text === undefined ? item : { ...item, text: input.text });
}

/** The item that a change wrote, and the slugs of the contracts that the change ended. */
export type ItemChange = { readonly item: WorkItem; readonly ended: readonly string[] };

/** The IDs of the items that a report set `done`, and the slugs of the contracts that it ended. */
export type LandedCommits = { readonly done: readonly number[]; readonly ended: readonly string[] };

/**
 * Changes the fields that `change` gives of the item `change.id` for the caller `by`, and gives the item and the slugs of
 * the contracts that the change ended. A change to `done` fails while a run or a task of `workers`, the workers of the
 * item, is live. A change to `done` or `dropped` ends each contract that shapes the item and no open item: `done` when
 * one item that it shapes is done, else `dropped`.
 */
export function setItem(tx: StoreTx, change: ItemSet, by: string, workers: ItemWorkers): ItemChange {
	const item = tx.item(change.id);

	if (change.state === "done") refuseLiveRun(item, workers);

	if (change.title !== undefined) item.title = change.title;

	if (change.text !== undefined) item.text = change.text;
	const ended = changeItem(tx, item, change.state, by);

	return { item: tx.item(item.id), ended };
}

/**
 * Writes the edge `item:<id> landed <commit>` for the caller `by`, for each item of `ids`, which the store has, and each
 * commit reference of `refs`, as a report of a worker of the item gives them, and sets each open item of them `done`.
 * A closed item keeps its state. Unlike `setItem`, a live run or task of the item does not refuse the change: the
 * reporter is such a task. It gives the IDs of the items that it set `done`, and the slugs of the contracts that it
 * ended. With no commit reference, it changes nothing.
 */
export function landCommits(tx: StoreTx, ids: readonly number[], refs: readonly string[], by: string): LandedCommits {
	const commits = refs.filter((ref) => Value.Check(CommitRef, ref));
	const done: number[] = [];
	const ended: string[] = [];

	if (commits.length === 0) return { done, ended };

	for (const id of ids) {
		for (const commit of commits) writeEdge(tx, { from: `item:${id}`, kind: "landed", to: commit }, by);
		const item = tx.item(id);

		if (item.state !== "open") continue;
		ended.push(...changeItem(tx, item, "done", by));
		done.push(id);
	}

	return { done, ended };
}

/** The items that the contract `slug` shapes in `tx`, in ID order: the items of the edges from the parley. */
export function contractItems(tx: StoreReader, slug: string): WorkItem[] {
	return tx.itemsFrom(`parley:${slug}`).map((id) => tx.item(id));
}

/**
 * Checks the edge `input` and writes it for the caller `by`, and gives it, as the request `item link` does. On top of
 * the checks of `writeEdge`, an agent has no `serves` edge, and a run serves one item at most.
 */
export function linkItem(tx: StoreTx, input: EdgeInput, by: string): Edge {
	if (input.kind === "serves") {
		const { id, other } = endsOf(input);
		const item = tx.item(id);
		const fresh = !item.edges.some((edge) => sameEdge(edge, input));

		// A stored edge is the reply, and a closed item fails in `writeEdge` with its state: both come before the refusal.
		if (fresh && item.state === "open") refuseServe(tx, other);
	}

	return writeEdge(tx, input, by);
}

/**
 * Checks the edge `input` and writes it as the last edge of its item for the caller `by`, and gives it. The kind fixes
 * the ends, a `needs` edge does not go from an item to itself, the item must exist, and an edge with the same ends and
 * kind is not written again: its stored edge is the reply. A `serves`, `shapes` or `needs` edge needs an open item, a
 * parley at the other end of a `shapes` edge, and an item at the other end of a `needs` edge, which must not make a
 * cycle of `needs` edges: `knownEnd` checks the other end. A run or a commit end is checked for its form only.
 */
export function writeEdge(tx: StoreTx, input: EdgeInput, by: string): Edge {
	const { id, other } = endsOf(input);
	const item = tx.item(id);
	const stored = item.edges.find((edge) => sameEdge(edge, input));

	if (stored !== undefined) return stored;

	if (input.kind !== "landed" && item.state !== "open") {
		const way = input.from === `item:${id}` ? "go from" : "go to";
		throw new Error(`Item ${id} is ${item.state}: an edge ${input.kind} cannot ${way} it`);
	}

	knownEnd(tx, id, other);
	const edge: Edge = { from: input.from, kind: input.kind, to: input.to, at: Date.now(), by };
	tx.addEdge(edge);

	return edge;
}

/**
 * Gives the contract `parley` an item in `tx` for the caller `by`: when no item has the edge `parley:<slug> shapes`, it
 * adds an item with the title of the parley and writes that edge.
 */
export function itemForContract(tx: StoreTx, parley: Readonly<Parley>, by: string): void {
	const end = `parley:${parley.slug}`;

	if (tx.itemsFrom(end).length > 0) return;
	const item = addItem(tx, { title: parley.title }, by);
	writeEdge(tx, { from: end, kind: "shapes", to: `item:${item.id}` }, by);
}

/** Removes the edge `input` of its item, and gives the item. The item keeps its `at` and `by`. */
export function unlinkItem(tx: StoreTx, input: EdgeInput): WorkItem {
	const { id } = endsOf(input);

	if (!tx.item(id).edges.some((edge) => sameEdge(edge, input))) {
		throw new Error(`Item ${id} has no edge ${input.from} ${input.kind} ${input.to}`);
	}

	tx.removeEdge(input);

	return tx.item(id);
}

/**
 * Ends the contract `parley` with the status `status` for the caller `by` in `tx`, and gives the ended parley.
 */
export function endContract(
	tx: StoreTx,
	parley: Readonly<Extract<Parley, { design_sense: string }>>,
	status: ParleyEnd,
	by: string,
): Parley {
	const ended: Parley = { ...parley, status, at: Date.now(), by };
	tx.putParley(ended);

	return ended;
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
 * Fails when a run or a task with the label `item:<id>` of `item` is live, and names the first one: the runs of the
 * started tasks of `workers` with the label, in any state of the task, then the live tasks with the label whose key is
 * of another form. A run (`wf:<runId>#<n>`) is live while a live task with the label is a task of the run, or while an
 * ask of the run is open.
 */
function refuseLiveRun(item: WorkItem, { tasks, workers, asks }: ItemWorkers): void {
	const refused = (worker: string) => new Error(`Item ${item.id} cannot be done: ${worker} serves it and is live`);

	for (const run of new Set(tasks.flatMap((key) => taskRun(key) ?? []))) {
		if (runLive(run, workers, asks)) throw refused(`run ${run}`);
	}

	const task = workers.find((worker) => worker.kind === "task" && taskRun(worker.key) === undefined);

	if (task?.kind === "task") throw refused(`task ${task.key}`);
}

/**
 * Sets the state of `item` to `state`, when it gives one, and its `at` and `by` for the caller `by`, and writes its
 * fields. A change to `done` or `dropped` ends each contract that shapes the item and no open item (`endContracts`),
 * and it gives their slugs.
 */
function changeItem(tx: StoreTx, item: WorkItem, state: ItemState | undefined, by: string): string[] {
	if (state !== undefined) item.state = state;
	item.at = Date.now();
	item.by = by;
	tx.putItem(item);

	return state === "done" || state === "dropped" ? endContracts(tx, item, by) : [];
}

/**
 * Ends each contract with an edge to `item`, a closed item, for the caller `by` when the contract shapes no open item:
 * `done` when one item that it shapes is done, else `dropped`. It gives the slugs of the contracts that it ended.
 */
function endContracts(tx: StoreTx, item: WorkItem, by: string): string[] {
	const ended: string[] = [];

	for (const slug of new Set(itemEnds(item).parleys)) {
		const parley = tx.findParleyBySlug(slug);

		if (parley?.status !== "contract") continue;
		const work = contractItems(tx, slug);

		if (work.some((found) => found.state === "open")) continue;
		endContract(tx, parley, work.some((found) => found.state === "done") ? "done" : "dropped", by);
		ended.push(slug);
	}

	return ended;
}

/**
 * The ID of the item that stores `edge`, and the reference at its other end. Ends that its kind does not take fail, and
 * so does an edge from an item to itself.
 */
function endsOf(edge: EdgeInput): EdgeItem {
	const ends = edgeEnds(edge);

	if (edge.from === edge.to) throw new Error(`An edge ${edge.kind} cannot go from ${edge.from} to itself`);

	return ends;
}

/**
 * Fails when `ref`, the end of an edge that the item `id` stores and that is not that item, is a parley that the store
 * does not have, or an item that the store does not have or that needs the item `id`, so that the edge would make a
 * cycle of `needs` edges. A run or a commit is not checked.
 */
function knownEnd(tx: StoreReader, id: number, ref: string): void {
	const { kind, value } = refParts(ref);

	if (kind === "parley") tx.parleyBySlug(value);
	else if (kind === "item") refuseCycle(tx, id, Number(value));
}

/**
 * Fails when the item `to` needs the item `from`, through its `needs` edges and those of the items it needs, so that the
 * edge `item:<from> needs item:<to>` would make a cycle.
 */
function refuseCycle(tx: StoreReader, from: number, to: number): void {
	const seen = new Set([to]);
	const next = [to];

	for (let id = next.pop(); id !== undefined; id = next.pop()) {
		for (const edge of tx.item(id).edges) {
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
 * through its label, or a run that already serves an item.
 */
function refuseServe(tx: StoreReader, from: string): void {
	const { kind, value } = refParts(from);

	if (kind === "agent") throw new Error("An agent serves an item through its label: spawn it with serves");
	const served = tx.itemsFrom(from)[0];

	if (served !== undefined) throw new Error(`Run ${value} already serves item ${served}`);
}

/** Whether `edge` has the ends and the kind of `input`. */
function sameEdge(edge: Edge, input: EdgeInput): boolean {
	return edge.from === input.from && edge.kind === input.kind && edge.to === input.to;
}
