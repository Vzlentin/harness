/**
 * The stage of a work item, its column on the board, and its mark `needsYou`, which the host works out at each read
 * from the state of the item and the other ends of its edges, and never stores.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ItemStage, StagedItem, WorkItem } from "../protocol/item.ts";
import type { Ask, HeldAction, Parley } from "../protocol/project.ts";
import type { Worker } from "../protocol/worker-labels.ts";
import { readOpenAsks } from "./asks.ts";
import { itemEnds } from "./item-docs.ts";
import { runAsker, runLive, taskRun } from "./items.ts";
import { readParleys } from "./parleys.ts";
import { readHeld } from "./project.ts";
import { labelledTasks, TaskLabels } from "./tasks.ts";
import { liveWorkers, type WorkerHost } from "./workers.ts";

const context = BACKGROUND_CONTEXT;

/** What the stage reads of the host: the store and the children library. */
export type StageHost = WorkerHost;

/**
 * What the stage reads of the store, once for each read of items: the parleys, the open asks, the held actions, the
 * labels of the tasks, and the live workers of each label.
 */
type StageInputs = {
	readonly parleys: readonly Parley[];
	readonly asks: readonly Ask[];
	readonly held: readonly HeldAction[];
	readonly taskLabels: Readonly<Record<string, readonly string[]>>;
	readonly workers: ReadonlyMap<string, readonly Worker[]>;
};

/** The other ends of an item for its stage: the live workers of its label, the agents of its label, and its runs. */
type StageEnds = {
	/** The live workers with the label of the item. */
	readonly workers: readonly Worker[];
	/** The conversations of the live agents with the label of the item. */
	readonly agents: readonly string[];
	/** The runs of its `serves` edges, and of the tasks with its label, in any state. */
	readonly runs: readonly string[];
};

/** `items` with their stages and their marks, in the same order. */
export async function stageItems(host: StageHost, items: readonly WorkItem[]): Promise<StagedItem[]> {
	const inputs = await readInputs(host);

	return items.map((item) => staged(inputs, item));
}

/** `item` with its stage and its mark. */
export async function stageItem(host: StageHost, item: WorkItem): Promise<StagedItem> {
	return staged(await readInputs(host), item);
}

/** The inputs of the stage, as the store has them now. */
async function readInputs(host: StageHost): Promise<StageInputs> {
	const [{ parleys }, { asks }, { held }, taskLabels, workers] = await Promise.all([
		readParleys(host.harness, context),
		readOpenAsks(host.harness, context),
		readHeld(host.harness, context),
		host.harness.snapshot(TaskLabels, context),
		liveWorkers(host),
	]);

	return { parleys, asks, held, taskLabels: taskLabels?.labels ?? {}, workers };
}

/**
 * `item` with its stage and its mark. The first check that holds gives the stage: the state `done` or `dropped`, a live
 * worker or run that serves it (`building`), an open parley that shapes it (`shaping`), a contract that shapes it
 * (`ready`), and else `inbox`. A worker serves the item with its label `item:<id>`. It needs the user when a parley that
 * shapes it has an open ask, a live agent of its label has an open ask or a held action, or a run that serves it has an
 * open ask.
 */
function staged(inputs: StageInputs, item: WorkItem): StagedItem {
	const { runs, parleys: slugs } = itemEnds(item);
	const parleys = inputs.parleys.filter((parley) => slugs.includes(parley.slug));
	const label = `item:${item.id}`;
	const workers = inputs.workers.get(label) ?? [];

	const labelled = labelledTasks(inputs.taskLabels, label).flatMap((key) => taskRun(key) ?? []);

	const ends: StageEnds = {
		workers,
		agents: workers.flatMap((worker) => (worker.kind === "agent" ? [worker.conversation] : [])),
		runs: [...new Set([...runs, ...labelled])],
	};

	return {
		...item,
		stage: stageOf(inputs, item, ends, parleys),
		needsYou: needsYou(inputs, ends, parleys),
	};
}

/** The stage of `item`, whose other ends are `ends`, and whose parleys are `parleys`. */
function stageOf(inputs: StageInputs, item: WorkItem, ends: StageEnds, parleys: readonly Parley[]): ItemStage {
	if (item.state !== "open") return item.state;

	if (served(inputs, ends)) return "building";

	if (parleys.some((parley) => parley.status === "open")) return "shaping";

	return parleys.some((parley) => parley.status === "contract") ? "ready" : "inbox";
}

/** Whether a worker or a run of `ends` is live. */
function served(inputs: StageInputs, ends: StageEnds): boolean {
	if (ends.workers.length > 0) return true;

	return ends.runs.some((run) => runLive(run, ends.workers, inputs.asks));
}

/** Whether a parley of `parleys`, or an agent or a run of `ends`, waits for the user. `inputs.asks` are open. */
function needsYou(inputs: StageInputs, ends: StageEnds, parleys: readonly Parley[]): boolean {
	const ids = new Set(parleys.map((parley) => parley.id));
	const askers = new Set([...ends.agents, ...ends.runs.map(runAsker)]);

	const asked = inputs.asks.some(
		(ask) => askers.has(ask.asker) || (ask.parley !== undefined && ids.has(ask.parley.id)),
	);

	return asked || inputs.held.some((held) => held.state === "held" && ends.agents.includes(held.agent));
}
