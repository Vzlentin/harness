/**
 * The rule that an agent lives as long as what it serves. A child serves the agent that spawned it, a parley, a
 * contract or a todo of the list of the project. When that thing ends, the host ends the child, once its own list has
 * no open and no doing todo.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitChange, Conversation } from "@earendil-works/pi-durable";
import { CHILD_DOC_KIND } from "../children/library.ts";
import { type Parley, PARLEYS_KIND } from "../protocol/project.ts";
import type { ServesInput } from "../protocol/requests.ts";
import { isFinished, TODO_LIST_KIND, type Todo } from "../protocol/todo.ts";
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
export type ServingHost = Pick<TargetHost, "harness" | "place" | "owner"> & {
	/** The root conversation, whose list is the list of the project. */
	readonly root: Conversation;
	readonly warn: (cause: unknown) => void;
};

type Entry = readonly [handle: string, record: ChildRecord];

/**
 * What a spawn with `input` serves: its spawner without `input`; an open parley, or a contract, by slug; or a todo of
 * the list of the project by ID. An unknown parley or todo, and one that ended, are refused.
 */
export async function servesOf(
	host: Pick<ServingHost, "harness" | "root">,
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

	const todo = (await readTodos(host.harness, projectList(host), context)).todos.find(({ id }) => id === input.todo);

	if (todo === undefined) throw new Error(`Unknown todo: ${input.todo}`);

	if (isFinished(todo.state)) throw new Error(`Todo ${todo.id} is ${todo.state}: an agent cannot serve it`);

	return { kind: "todo", id: todo.id };
}

/** What a sweep reads once: the parleys, and the list of the project. */
type Served = { readonly parleys: readonly Parley[]; readonly projectTodos: readonly Todo[] };

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

		if (entries.length === 0) return;

		const served: Served = {
			parleys: (await readParleys(harness, context)).parleys,
			projectTodos: (await readTodos(harness, projectList(this.#host), context)).todos,
		};

		for (const [handle, record] of entries) {
			if (this.#passes.stopped) return;

			if (record.servedEnd !== undefined) continue;

			try {
				if (!(await this.#ended(record, entries, served))) continue;

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
	 * agent, a Pi session, `cli` and a conversation of a task never end by the rule.
	 */
	async #ended(record: ChildRecord, entries: readonly Entry[], served: Served): Promise<boolean> {
		const { serves } = record;

		switch (serves.kind) {
			case "spawner": {
				const spawner = conversationEntry(entries, record.caller);

				return spawner !== undefined && (await childEnded(this.#host, spawner[1]));
			}

			case "parley":
			case "contract": {
				const status = served.parleys.find(({ slug }) => slug === serves.slug)?.status;

				return status !== undefined && (serves.kind === "parley" ? status !== "open" : isFinished(status));
			}

			case "todo": {
				const state = served.projectTodos.find(({ id }) => id === serves.id)?.state;

				return state !== undefined && isFinished(state);
			}
		}
	}
}

/** The list of the project: the list of the root conversation. */
function projectList(host: Pick<ServingHost, "root">): TodoOwner {
	return { kind: "conversation", id: host.root.id };
}

/**
 * Whether `change` can end a served thing or change a list of todos: the records of the children, the end of a child,
 * the parleys, and the list of a conversation.
 */
function endsServed(change: CommitChange): boolean {
	if (change.type !== "document") return false;

	return [ChildRecords.definition.kind, CHILD_DOC_KIND, PARLEYS_KIND, TODO_LIST_KIND].includes(change.record.kind);
}
