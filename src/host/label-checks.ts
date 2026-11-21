/**
 * The checks of the labels of a new worker: the check of a label kind, the check of a list of labels, and the state of
 * the work of the project, whose label kinds `parley:<slug>` and `item:<id>` the host owns.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { refParts } from "../protocol/item.ts";
import { LocalId } from "../protocol/project.ts";
import { isFinished } from "../protocol/todo.ts";
import { Items } from "./item-docs.ts";
import { readParleys } from "./parleys.ts";

const context = BACKGROUND_CONTEXT;

/** The check of the labels of one kind, which throws the reason when it refuses `label`. */
export type LabelCheck = (label: string) => Promise<void>;

/**
 * Checks each label of `labels` with the check of its kind in `checks`, in order, and throws the reason of the first
 * one that it refuses. A label of a kind with no check is refused.
 */
export async function checkLabels(checks: ReadonlyMap<string, LabelCheck>, labels: readonly string[]): Promise<void> {
	for (const label of labels) {
		const { kind } = refParts(label);
		const check = checks.get(kind);

		if (check === undefined) throw new Error(`no loaded entry checks the label kind "${kind}"`);
		await check(label);
	}
}

/**
 * The state of the work of a label: `open`, `ended`, or `unknown` to the store, with the reason that refuses a new
 * worker of it.
 */
export type WorkState = { readonly state: "open" } | { readonly state: "ended" | "unknown"; readonly reason: string };

/** What the states of the work read of the host. */
type WorkReader = Pick<DocumentReader, "snapshot">;

/** The state of the work of a label from the value of the label. */
type ReadWork = (reader: WorkReader, value: string) => Promise<WorkState>;

/** A parley of the store is open while it is open or a contract. */
const parleyState: ReadWork = async (reader, slug) => {
	const parley = (await readParleys(reader, context)).parleys.find((found) => found.slug === slug);

	if (parley === undefined) return { state: "unknown", reason: `Unknown parley: ${slug}` };

	if (isFinished(parley.status)) {
		return { state: "ended", reason: `Parley ${parley.slug} is ${parley.status}: an agent cannot serve it` };
	}

	return { state: "open" };
};

/** An item of the store, by its ID in the value, is open while its state is `open`. */
const itemState: ReadWork = async (reader, value) => {
	const id = Number(value);

	const item =
		Value.Check(LocalId, id) && String(id) === value ? await reader.snapshot(Items, value, context) : undefined;

	if (item === undefined) return { state: "unknown", reason: `Unknown item: ${value}` };

	if (item.state !== "open")
		return { state: "ended", reason: `Item ${item.id} is ${item.state}: an agent cannot serve it` };

	return { state: "open" };
};

/** The state of the work of each label kind that the host owns. */
const WORK: ReadonlyMap<string, ReadWork> = new Map([
	["parley", parleyState],
	["item", itemState],
]);

/** The label kinds of the work of the project, which the host checks and no entry can claim. */
export const WORK_KINDS: ReadonlySet<string> = new Set(WORK.keys());

/** The state of the work of `label`, or nothing for a label of a kind that the host does not own. */
export async function workState(reader: WorkReader, label: string): Promise<WorkState | undefined> {
	const { kind, value } = refParts(label);

	return WORK.get(kind)?.(reader, value);
}

/** The checks of the label kinds of `WORK_KINDS`, which read `reader`: they refuse work that is not open. */
export function workLabelChecks(reader: WorkReader): ReadonlyMap<string, LabelCheck> {
	const check: LabelCheck = async (label) => {
		const work = await workState(reader, label);

		if (work !== undefined && work.state !== "open") throw new Error(work.reason);
	};

	return new Map([...WORK_KINDS].map((kind) => [kind, check]));
}
