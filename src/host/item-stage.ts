/**
 * The stage of a work item, its column on the board, and its mark `needsYou`, which the host works out at each read
 * from the state of the item and the other ends of its edges, and never stores.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ItemStage, StagedItem, WorkItem } from "../protocol/item.ts";
import type { Ask, HeldAction, Parley } from "../protocol/project.ts";
import { type ItemEnds, itemEnds } from "./item-docs.ts";
import { runAsker, runLive } from "./items.ts";
import { readHeld, readOpenAsks, readParleys } from "./project.ts";
import { library, type TargetHost } from "./targets.ts";
import { type StartedTaskIds, StartedTasks, type TaskHost } from "./tasks.ts";

const context = BACKGROUND_CONTEXT;

/** What the stage reads of the host: the store, the children library, and the project agent. */
export type StageHost = Pick<TargetHost, "harness" | "place"> & Pick<TaskHost, "root">;

/**
 * What the stage reads of the store, once for each read of items: the parleys, the open asks, the held actions, and the
 * started tasks.
 */
type StageInputs = {
	readonly parleys: readonly Parley[];
	readonly asks: readonly Ask[];
	readonly held: readonly HeldAction[];
	readonly started: StartedTaskIds;
};

/** `items` with their stages and their marks, in the same order. */
export async function stageItems(host: StageHost, items: readonly WorkItem[]): Promise<StagedItem[]> {
	const inputs = await readInputs(host);

	return Promise.all(items.map((item) => staged(host, inputs, item)));
}

/** `item` with its stage and its mark. */
export async function stageItem(host: StageHost, item: WorkItem): Promise<StagedItem> {
	return staged(host, await readInputs(host), item);
}

/** The inputs of the stage, as the store has them now. */
async function readInputs(host: StageHost): Promise<StageInputs> {
	const [{ parleys }, { asks }, { held }, started] = await Promise.all([
		readParleys(host.harness, context),
		readOpenAsks(host.harness, context),
		readHeld(host.harness, context),
		host.harness.snapshot(StartedTasks, context),
	]);

	return { parleys, asks, held, started: started ?? { tasks: {} } };
}

/**
 * `item` with its stage and its mark. The first check that holds gives the stage: the state `done` or `dropped`, a live
 * agent or run that serves it (`building`), an open parley that shapes it (`shaping`), a contract that shapes it
 * (`ready`), and else `inbox`. It needs the user when a parley that shapes it has an open ask, an agent that serves it
 * has an open ask or a held action, or a run that serves it has an open ask.
 */
async function staged(host: StageHost, inputs: StageInputs, item: WorkItem): Promise<StagedItem> {
	const ends = itemEnds(item);
	const parleys = inputs.parleys.filter((parley) => ends.parleys.includes(parley.slug));

	return {
		...item,
		stage: await stageOf(host, inputs, item, ends, parleys),
		needsYou: needsYou(inputs, ends, parleys),
	};
}

/** The stage of `item`, whose other ends are `ends`, and whose parleys are `parleys`. */
async function stageOf(
	host: StageHost,
	inputs: StageInputs,
	item: WorkItem,
	ends: ItemEnds,
	parleys: readonly Parley[],
): Promise<ItemStage> {
	if (item.state !== "open") return item.state;

	if (await served(host, inputs, ends)) return "building";

	if (parleys.some((parley) => parley.status === "open")) return "shaping";

	return parleys.some((parley) => parley.status === "contract") ? "ready" : "inbox";
}

/** Whether an agent or a run of `ends` is live. */
async function served(host: StageHost, inputs: StageInputs, ends: ItemEnds): Promise<boolean> {
	const live = await Promise.all([
		...ends.agents.map((id) => agentLive(host, id)),
		...ends.runs.map((run) => runLive(run, inputs.started, inputs.asks, (id) => host.harness.getTask(id, context))),
	]);

	return live.includes(true);
}

/**
 * Whether the agent of the conversation `id` is live: the project agent, or a conversation of the children library that
 * did not end.
 */
async function agentLive(host: StageHost, id: string): Promise<boolean> {
	if (id === String(host.root.id)) return true;
	const child = await library.inspect(host.place, id, context);

	return child !== undefined && (await child.state(context)) !== "ended";
}

/** Whether a parley of `parleys`, or an agent or a run of `ends`, waits for the user. `inputs.asks` are open. */
function needsYou(inputs: StageInputs, ends: ItemEnds, parleys: readonly Parley[]): boolean {
	const ids = new Set(parleys.map((parley) => parley.id));
	const askers = new Set([...ends.agents, ...ends.runs.map(runAsker)]);

	const asked = inputs.asks.some(
		(ask) => askers.has(ask.asker) || (ask.parley !== undefined && ids.has(ask.parley.id)),
	);

	return asked || inputs.held.some((held) => held.state === "held" && ends.agents.includes(held.agent));
}
