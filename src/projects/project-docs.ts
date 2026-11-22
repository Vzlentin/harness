/**
 * The parts of the documents of the project in `durable.sqlite` that its modules share: the documents of the session,
 * the parleys, the lookup of an object by its ID, the lookup of a parley by its slug, and the end of a contract. The
 * asks are in `asks.ts`.
 */
import type { JsonObject } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { boundedReplay } from "../host/checkpoint.ts";
import { type Parley, type ParleyEnd, type ParleyList, PARLEYS_KIND } from "../protocol/project.ts";

export const Parleys = sessionDoc<ParleyList>(PARLEYS_KIND, () => ({ parleys: [] }));

/** A document of the session of the kind `kind`, which starts as `initial()`. */
export function sessionDoc<T extends JsonObject>(kind: string, initial: () => T) {
	return durable.defineDoc<T>({ kind, version: 1, scope: "session", checkpointWhen: boundedReplay, initial });
}

/** The item `id` of `items`. An ID of no item fails with `Unknown <name>: <id>`. */
export function known<T extends { readonly id: number }>(items: readonly T[], id: number, name: string): T {
	const item = items.find((found) => found.id === id);

	if (item === undefined) throw new Error(`Unknown ${name}: ${id}`);

	return item;
}

/**
 * Ends the contract `parley` of `parleys` with the status `status` for the caller `by`: it replaces the parley in place,
 * and gives a copy of the ended parley.
 */
export function endContract(
	parleys: Parley[],
	parley: Readonly<Extract<Parley, { design_sense: string }>>,
	status: ParleyEnd,
	by: string,
): Parley {
	const ended: Parley = { ...parley, status, at: Date.now(), by };
	parleys[parleys.indexOf(parley)] = ended;

	return Value.Clone(ended);
}

/** The parley `slug` of `parleys`. A slug of no parley fails with `Unknown parley: <slug>`. */
export function knownParley(parleys: readonly Parley[], slug: string): Parley {
	const parley = parleys.find((found) => found.slug === slug);

	if (parley === undefined) throw new Error(`Unknown parley: ${slug}`);

	return parley;
}
