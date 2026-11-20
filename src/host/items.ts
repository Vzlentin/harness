/**
 * The changes of the work items of the store of the project, each in the commit that a caller gives: the `item`
 * request changes them with these functions, each change in its own commit, and a spawn writes the `serves` edge of
 * its child in the commit that creates the child. A round of asks writes the `shapes` edge of its parley, and the commit
 * that makes a parley a contract gives it an item when it shapes none. A load of a store file writes its items, with their
 * edges and the counter. It also gives whether a run is live: the stage of an item reads it,
 * and a live run refuses a change of its item to `done`.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId, TaskId, TaskRecord, Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import {
	type Edge,
	type EdgeInput,
	type EdgeItem,
	edgeItem,
	type ItemAdd,
	type ItemSet,
	refParts,
	type WorkItem,
} from "../protocol/item.ts";
import type { Ask, Parley } from "../protocol/project.ts";
import { ItemCounterDoc, itemEnds, Items } from "./item-docs.ts";
import type { ItemIndex } from "./item-index.ts";
import { Asks, knownParley, Parleys } from "./project-docs.ts";
import { type StartedTaskIds, StartedTasks } from "./tasks.ts";

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
 * Changes the fields that `change` gives of the item `change.id` for the caller `by`, and gives the item. A change to
 * `done` fails while a run that serves the item is live.
 */
export async function setItem(tx: Tx, change: ItemSet, by: string): Promise<WorkItem> {
	const item = await itemDraft(tx, change.id);

	if (change.state === "done") await refuseLiveRun(tx, item);

	if (change.title !== undefined) item.title = change.title;

	if (change.text !== undefined) item.text = change.text;

	if (change.state !== undefined) item.state = change.state;
	item.at = Date.now();
	item.by = by;

	return Value.Clone(item);
}

/**
 * Checks the edge `input` and writes it into the document of its item for the caller `by`, and gives it, as the request
 * `item link` does. On top of the checks of `writeEdge`, only the spawn of an agent writes its `serves` edge, and a run
 * serves one item at most: `items` gives the items of the run.
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
 * the ends, the item must exist, and an edge with the same ends and kind is not written again: its stored edge is the
 * reply. A `serves` or `shapes` edge needs an open item, and a parley at the other end of a `shapes` edge. A run or a
 * commit end is checked for its form only.
 */
export async function writeEdge(tx: Tx, input: EdgeInput, by: string): Promise<Edge> {
	const { id, other } = endsOf(input);
	const item = await itemDraft(tx, id);
	const stored = item.edges.find((edge) => sameEdge(edge, input));

	if (stored !== undefined) return Value.Clone(stored);

	if (input.kind !== "landed" && item.state !== "open") {
		throw new Error(`Item ${id} is ${item.state}: an edge ${input.kind} cannot go to it`);
	}

	await knownEnd(tx, other);
	const edge: Edge = { from: input.from, kind: input.kind, to: input.to, at: Date.now(), by };
	item.edges.push({ ...edge });

	return edge;
}

/**
 * Writes the edge `agent:<conversationId> serves item:<id>` into the item `id` for the caller `by`, in `tx`, the commit
 * that creates the child of the conversation `conversationId`. The item must be open. It reads only documents, which a
 * commit can read after its writes of tables, such as the creation of the child.
 */
export async function serveItem(tx: Tx, id: number, conversationId: ConversationId, by: string): Promise<void> {
	const item = await itemDraft(tx, id);

	if (item.state !== "open") throw new Error(`Item ${id} is ${item.state}: an agent cannot serve it`);
	item.edges.push({ from: `agent:${conversationId}`, kind: "serves", to: `item:${id}`, at: Date.now(), by });
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
 * an input of the user, or a task that `start` created with a key `wf:<runId>#<n>` of `started` is not terminal, which
 * is a run state `pending` or `running` in the tree. `task` reads a task, and gives nothing for an unknown ID.
 */
export async function runLive(
	runId: string,
	started: StartedTaskIds,
	asks: readonly Ask[],
	task: (id: TaskId<JsonValue>) => Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>,
): Promise<boolean> {
	const asker = runAsker(runId);

	if (asks.some((ask) => ask.state === "open" && ask.asker === asker)) return true;

	for (const [key, id] of Object.entries(started.tasks)) {
		if (taskRun(key) !== runId) continue;
		const record = await task(id);

		if (record !== undefined && record.state.status !== "terminal") return true;
	}

	return false;
}

/** The run ID of the task whose `start` key is `key`, `wf:<runId>#<n>`, and nothing for a key of another form. */
export function taskRun(key: string): string | undefined {
	return RUN_TASK_KEY.exec(key)?.[1];
}

/**
 * Fails when a run that serves `item` is live in `tx`, and names the first one in the order of the edges. An item with
 * no run reads nothing, because `tx.doc` creates a document that is missing.
 */
async function refuseLiveRun(tx: Tx, item: WorkItem): Promise<void> {
	const { runs } = itemEnds(item);

	if (runs.length === 0) return;
	const started = await tx.doc(StartedTasks);
	const { asks } = await tx.doc(Asks);

	for (const run of runs) {
		if (await runLive(run, started, asks, (id) => tx.task(id))) {
			throw new Error(`Item ${item.id} cannot be done: run ${run} serves it and is live`);
		}
	}
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

/** The ID of the item at one end of `edge`, and the reference at its other end. Ends that its kind does not take fail. */
function endsOf(edge: EdgeInput): EdgeItem {
	const ends = edgeItem(edge);

	if (ends === undefined) throw new Error(`An edge ${edge.kind} cannot go from ${edge.from} to ${edge.to}`);

	return ends;
}

/**
 * Fails when `ref`, the end of an edge that is not its item, is a parley that the store does not have. A run or a
 * commit is not checked.
 */
async function knownEnd(tx: Tx, ref: string): Promise<void> {
	const { kind, value } = refParts(ref);

	if (kind === "parley") knownParley((await tx.doc(Parleys)).parleys, value);
}

/**
 * Fails when `from`, the end of a new `serves` edge of `item link`, cannot write it: an agent, whose spawn writes its
 * only `serves` edge, or a run that `items` gives an item for.
 */
function refuseServe(from: string, items: Pick<ItemIndex, "itemsOf">): void {
	const { kind, value } = refParts(from);

	if (kind === "agent") throw new Error("Only the spawn of an agent writes its edge serves");
	const served = items.itemsOf(from)[0];

	if (served !== undefined) throw new Error(`Run ${value} already serves item ${served}`);
}

/** Whether `edge` has the ends and the kind of `input`. */
function sameEdge(edge: Edge, input: EdgeInput): boolean {
	return edge.from === input.from && edge.kind === input.kind && edge.to === input.to;
}
