/**
 * The rule that an agent lives as long as what it serves. A child serves the agent that spawned it, a parley, a
 * contract or a work item, whose `serves` edge names the child. When that thing ends, the host ends the child, once its
 * own list has no open and no doing todo.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitChange } from "@earendil-works/pi-durable";
import { CHILD_DOC_KIND } from "../children/library.ts";
import { ITEM_KIND } from "../protocol/item.ts";
import { type Parley, PARLEYS_KIND } from "../protocol/project.ts";
import type { ServesInput } from "../protocol/requests.ts";
import { isFinished, TODO_LIST_KIND } from "../protocol/todo.ts";
import { readItem } from "./item-docs.ts";
import { CommitPasses } from "./passes.ts";
import { readParley, readParleys } from "./project.ts";
import {
	type ChildRecord,
	ChildRecords,
	type ChildServes,
	conversationEntry,
	markServedPassed,
	recordsByAge,
} from "./records.ts";
import { childEnded, endChildren, type TargetHost } from "./targets.ts";
import { readTodos, type TodoOwner } from "./todo.ts";

const context = BACKGROUND_CONTEXT;

/** What the rule uses of the host. */
export type ServingHost = Pick<TargetHost, "harness" | "place" | "owner" | "items"> & {
	readonly warn: (cause: unknown) => void;
};

type Entry = readonly [handle: string, record: ChildRecord];

/**
 * What a spawn with `input` serves: its spawner without `input`; an open parley, or a contract, by slug; or an item by
 * ID. An unknown parley, and one that ended, are refused. The spawn writes the `serves` edge of the item in the commit
 * that creates the child, and that commit refuses an unknown item and one that is not open.
 */
export async function servesOf(
	host: Pick<ServingHost, "harness">,
	input: ServesInput | undefined,
): Promise<ChildServes> {
	if (input === undefined) return { kind: "spawner" };

	if ("parley" in input) {
		const { parley } = await readParley(host.harness, input.parley, context);

		switch (parley.status) {
			case "open":
				return { kind: "parley", slug: parley.slug };
			case "contract":
				return { kind: "contract", slug: parley.slug };
			default:
				throw new Error(`Parley ${parley.slug} is ${parley.status}: an agent cannot serve it`);
		}
	}

	return { kind: "item" };
}

/**
 * Ends each child whose served thing ended, once its own list has no open and no doing todo: it aborts the child alone,
 * whose children follow the rule for themselves, and marks its requests read, as a `stop` does. The rule ends a child
 * once, so a child that a message resumed stays. A child that is already ended, by a `stop` or the end of its
 * session, is only marked, so a delivery still resumes it. A pass runs at the start and after each commit that can
 * end a served thing or change a list of todos.
 */
export class Serving {
	readonly #host: ServingHost;
	readonly #passes: CommitPasses;

	constructor(host: ServingHost) {
		this.#host = host;
		this.#passes = new CommitPasses(host.harness, endsServed, () => this.#sweep().catch(host.warn));
	}

	/** Stops the passes, and waits for the pass in progress. */
	close(): Promise<void> {
		return this.#passes.close();
	}

	/** Ends the children whose served thing ended, oldest first: a child sees the end of its spawner in the same pass. */
	async #sweep(): Promise<void> {
		const { harness } = this.#host;
		const entries = recordsByAge(await harness.snapshot(ChildRecords, context));

		const unchecked = entries.filter(([, record]) => record.servedEnd === undefined);

		if (unchecked.length === 0) return;

		const { parleys } = await readParleys(harness, context);

		for (const [handle, record] of unchecked) {
			if (this.#passes.stopped) return;

			try {
				if (!(await this.#ended(record, entries, parleys))) continue;

				if (await childEnded(this.#host, record)) {
					await markServedPassed(harness, handle);
					continue;
				}

				const owner: TodoOwner = { kind: "conversation", id: record.conversationId };
				const { todos } = await readTodos(harness, owner, context);

				if (todos.some((todo) => !isFinished(todo.state))) continue;
				await endChildren(this.#host, [record], { served: true });
			} catch (cause) {
				this.#host.warn(cause);
			}
		}
	}

	/**
	 * Whether what `record` serves ended. A spawner ends only when it is a child of this host and ended; the project
	 * agent, a Pi session, `cli` and a conversation of a task never end by the rule. An item is the item whose `serves`
	 * edge names the child, from the index of the ends of the items: a child that no edge names does not end by the rule.
	 * `parleys` are the parleys of the store.
	 */
	async #ended(record: ChildRecord, entries: readonly Entry[], parleys: readonly Parley[]): Promise<boolean> {
		const { serves } = record;

		switch (serves.kind) {
			case "spawner": {
				const spawner = conversationEntry(entries, record.caller);

				return spawner !== undefined && (await childEnded(this.#host, spawner[1]));
			}

			case "parley":
			case "contract": {
				const status = parleys.find(({ slug }) => slug === serves.slug)?.status;

				return status !== undefined && (serves.kind === "parley" ? status !== "open" : isFinished(status));
			}

			case "item": {
				const id = this.#host.items.childItem(record.conversationId);

				return id !== undefined && (await readItem(this.#host.harness, id, context)).state !== "open";
			}
		}
	}
}

/**
 * Whether `change` can end a served thing or change a list of todos: the records of the children, the end of a child,
 * the parleys, the items, and the list of a conversation.
 */
function endsServed(change: CommitChange): boolean {
	if (change.type !== "document") return false;

	return [ChildRecords.definition.kind, CHILD_DOC_KIND, PARLEYS_KIND, ITEM_KIND, TODO_LIST_KIND].includes(
		change.record.kind,
	);
}
