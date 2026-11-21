/**
 * The state of the work of the project behind a label: the label kinds `parley:<slug>` and `item:<id>`, which the
 * projects entry owns, and their checks, which refuse a new worker of work that is not open.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { LabelCheck } from "../host/label-checks.ts";
import { refParts } from "../protocol/item.ts";
import { LocalId } from "../protocol/project.ts";
import { isFinished } from "../protocol/todo.ts";
import { Items } from "./item-docs.ts";
import { readParleys } from "./parleys.ts";

const context = BACKGROUND_CONTEXT;

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

/** The state of the work of each label kind of the project. */
const WORK: ReadonlyMap<string, ReadWork> = new Map([
	["parley", parleyState],
	["item", itemState],
]);

/** The state of the work of `label`, or nothing for a label of a kind that is not work of the project. */
export async function workState(reader: WorkReader, label: string): Promise<WorkState | undefined> {
	const { kind, value } = refParts(label);

	return WORK.get(kind)?.(reader, value);
}

/**
 * The checks of the label kinds of the work of the project, which read the reader that `reader` gives at each check:
 * they refuse work that is not open.
 */
export function workLabelChecks(reader: () => WorkReader): { kind: string; check: LabelCheck }[] {
	const check: LabelCheck = async (label) => {
		const work = await workState(reader(), label);

		if (work !== undefined && work.state !== "open") throw new Error(work.reason);
	};

	return [...WORK.keys()].map((kind) => ({ kind, check }));
}
