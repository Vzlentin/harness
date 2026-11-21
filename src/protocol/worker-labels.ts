/**
 * The labels of the work of a project: the text that ties an agent or a task to the work that it does, such as
 * `parley:<slug>` or `item:<id>`, and the workers that a label gives.
 */
import { type Static, Type } from "typebox";
import { LocalId, Slug } from "./project.ts";

/** A label of a worker: its kind, the text before the first `:`, names the entry that checks it. */
export const Label = Type.String({ minLength: 1 });

export type Label = Static<typeof Label>;

/** What a `spawn` names that the child serves: a parley by slug, or a work item by ID. */
export const SpawnServes = Type.Union([
	Type.Object({ parley: Slug }, { additionalProperties: false }),
	Type.Object({ item: LocalId }, { additionalProperties: false }),
]);

export type SpawnServes = Static<typeof SpawnServes>;

/** The label of `serves`: `parley:<slug>` or `item:<id>`. */
export function servesLabel(serves: SpawnServes): string {
	return "parley" in serves ? `parley:${serves.parley}` : `item:${serves.item}`;
}

/** The labels of a worker: `labels`, then the label of `serves`, each once. */
export function workerLabels(labels: readonly string[] | undefined, serves: SpawnServes | undefined): string[] {
	return [...new Set([...(labels ?? []), ...(serves === undefined ? [] : [servesLabel(serves)])])];
}

/**
 * A live worker of a label: a child of the host by handle, with the ID of its conversation, `running` while it works
 * and `idle` else, or a started task by key that is not terminal.
 */
export type Worker =
	| {
			readonly kind: "agent";
			readonly handle: string;
			readonly conversation: string;
			readonly state: "running" | "idle";
	  }
	| { readonly kind: "task"; readonly key: string; readonly state: "running" };
