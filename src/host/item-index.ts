/**
 * The index of the ends of the work items: the IDs of the items whose edges come from each `agent:`, `run:` and
 * `parley:` end, and the run of each started task. The host builds it once from the items and keeps it current with the commits.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	CommitChange,
	CommitObservation,
	ConversationId,
	DocumentCommitChange,
	Harness,
	Storage,
} from "@earendil-works/pi-durable";
import { CHILD_DOC_KIND } from "../children/library.ts";
import type { WorkItem } from "../protocol/item.ts";
import { allItems, changedItemId } from "./item-docs.ts";
import { taskRun } from "./items.ts";
import { type StartedTaskIds, StartedTasks } from "./tasks.ts";

const context = BACKGROUND_CONTEXT;

/** A change or a retire of a document that a commit stored. */
type StoredDocumentChange = Extract<DocumentCommitChange, { readonly type: "document" }>;

/**
 * The items of each `agent:`, `run:` and `parley:` end. Its observer of the commits attaches before the other observers of the
 * host, so they see it current with each commit: pi-durable calls the observers in the order that they attached.
 */
export class ItemIndex {
	/** The ends of each item, by item ID: `agent:<conversationId>`, `run:<runId>` and `parley:<slug>`. */
	readonly #ends = new Map<number, readonly string[]>();
	/** The IDs of the items of each end. */
	readonly #items = new Map<string, Set<number>>();
	/** The run ID of each task that `start` created with a key `wf:<runId>#<n>`, by task ID. */
	readonly #runs = new Map<number, string>();
	/** The IDs of the items that a commit changed during the build; nothing once the build is done. */
	#building: Set<number> | undefined = new Set();
	#observation: CommitObservation | undefined;

	/**
	 * Builds the index from the items and the started tasks of `harness`, and keeps it current with its commits.
	 * `storage`, the storage of `harness`, lists the items. A commit during the build wins over the read of its item.
	 */
	static async open(
		harness: Pick<Harness, "observeCommits" | "snapshot">,
		storage: Pick<Storage, "scanDocuments">,
	): Promise<ItemIndex> {
		const index = new ItemIndex();

		index.#observation = harness.observeCommits({
			advance: (publication) => {
				const ids = index.#advance(publication.changes);

				for (const id of ids) index.#building?.add(id);
			},
			end: () => {},
		});

		try {
			const [items, started] = await Promise.all([
				allItems(harness, storage, context),
				harness.snapshot(StartedTasks, context),
			]);

			const changed = index.#building;
			index.#building = undefined;

			for (const item of items) if (!changed?.has(item.id)) index.#set(item);

			if (started !== undefined) index.#addRuns(started);
		} catch (error) {
			index.close();
			throw error;
		}

		return index;
	}

	/** Stops following the commits. */
	close(): void {
		this.#observation?.detach();
	}

	/**
	 * The ID of the item that the child of the conversation `conversationId` serves. Only the spawn of the child writes
	 * its `serves` edge, so one item at most has it.
	 */
	childItem(conversationId: ConversationId): number | undefined {
		return this.itemsOf(`agent:${conversationId}`)[0];
	}

	/** The IDs of the items whose edges come from `end`, an `agent:`, a `run:` or a `parley:` reference, in ID order. */
	itemsOf(end: string): number[] {
		return [...(this.#items.get(end) ?? [])].sort((a, b) => a - b);
	}

	/**
	 * The IDs of the items at whose ends `change` changes a node of the tree, in ID order: the document of a child
	 * names its agent, and a task that `start` created names its run. Another change names none.
	 */
	nodeItems(change: CommitChange): number[] {
		if (change.type === "task") {
			const run = this.#runs.get(change.value.id);

			return run === undefined ? [] : this.itemsOf(`run:${run}`);
		}

		if (change.type === "document" && change.record.kind === CHILD_DOC_KIND && change.conversationId !== undefined) {
			return this.itemsOf(`agent:${change.conversationId}`);
		}

		return [];
	}

	/**
	 * Applies `changes`, the changes of one commit, and gives the IDs of the items that they change. The started tasks
	 * come first, because the order of the changes of a commit is not given.
	 */
	#advance(changes: readonly CommitChange[]): number[] {
		const documents = changes.filter((change): change is StoredDocumentChange => change.type === "document");

		for (const change of documents) {
			if (change.kind !== "change" || change.record.kind !== StartedTasks.definition.kind) continue;
			// SAFETY: only `StartedTasks` has its kind, and its value is a `StartedTaskIds`.
			this.#addRuns(change.value as StartedTaskIds);
		}

		return documents.flatMap((change) => {
			const id = changedItemId(change);

			if (id === undefined) return [];

			if (change.kind === "retire") {
				this.#remove(id);

				return [id];
			}

			// SAFETY: only `Items` has its kind, and its value is a `WorkItem`.
			this.#set(change.value as WorkItem);

			return [id];
		});
	}

	/** Records the ends of `item` in place of those it had. */
	#set(item: Readonly<WorkItem>): void {
		this.#remove(item.id);
		const ends = item.edges.flatMap((edge) => (edge.from.startsWith("item:") ? [] : [edge.from]));
		this.#ends.set(item.id, ends);

		for (const end of ends) {
			const items = this.#items.get(end) ?? new Set();
			items.add(item.id);
			this.#items.set(end, items);
		}
	}

	/** Removes the ends of the item `id`. */
	#remove(id: number): void {
		for (const end of this.#ends.get(id) ?? []) {
			const items = this.#items.get(end);
			items?.delete(id);

			if (items?.size === 0) this.#items.delete(end);
		}

		this.#ends.delete(id);
	}

	/** Records the run of each task of `started` whose key is `wf:<runId>#<n>`. */
	#addRuns(started: Readonly<StartedTaskIds>): void {
		for (const [key, id] of Object.entries(started.tasks)) {
			const run = taskRun(key);

			if (run !== undefined) this.#runs.set(id, run);
		}
	}
}
