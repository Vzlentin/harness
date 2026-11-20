/** The reply and the events of `watch-project`: the objects of the store of the project, and the degraded states. */
import { type Static, Type } from "typebox";
import { StagedItem } from "./item.ts";
import { Ask, DegradedState, HeldAction, LocalId, Parley, Person, ProjectThread, Rule, StoreId } from "./project.ts";

/**
 * The reply of `watch-project`: every person, rule, thread with its waits, held action, parley and ask, in ID order,
 * the open work items with their stages, in ID order, and the degraded states of the host, oldest first.
 */
export const ProjectState = Type.Object({
	persons: Type.Array(Person),
	rules: Type.Array(Rule),
	threads: Type.Array(ProjectThread),
	held: Type.Array(HeldAction),
	parleys: Type.Array(Parley),
	asks: Type.Array(Ask),
	items: Type.Array(StagedItem),
	degraded: Type.Array(DegradedState),
});

export type ProjectState = Static<typeof ProjectState>;

/**
 * An event of `watch-project` after its reply: the objects of each kind that are new or changed, and in `removed` the
 * IDs of each kind of the objects that went. Every list is there, empty when nothing of its kind changed. An item that
 * becomes done or dropped comes once, with its state. `degraded` is the whole list of the degraded states of the host.
 */
export const ProjectEvent = Type.Object({
	...ProjectState.properties,
	removed: Type.Object({
		persons: Type.Array(LocalId),
		rules: Type.Array(LocalId),
		threads: Type.Array(StoreId),
		held: Type.Array(LocalId),
		parleys: Type.Array(LocalId),
		asks: Type.Array(LocalId),
		items: Type.Array(LocalId),
	}),
});

export type ProjectEvent = Static<typeof ProjectEvent>;
