/**
 * The index of the ends of the work items: the IDs of the items whose edges come from each `run:` and `parley:` end.
 * The host builds it once from the items and keeps it current with the commits.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	CommitChange,
	CommitObservation,
	DocumentCommitChange,
	Harness,
	Storage,
} from "@earendil-works/pi-durable";
import type { WorkItem } from "../protocol/item.ts";
import { allItems, changedItemId } from "./item-docs.ts";

const context = BACKGROUND_CONTEXT;

/** A change or a retire of a document that a commit stored. */
type StoredDocumentChange = Extract<DocumentCommitChange, { readonly type: "document" }>;

/**
 * The items of each `run:` and `parley:` end. Its observer of the commits attaches before the other observers of the
 * host, so they see it current with each commit: pi-durable calls the observers in the order that they attached.
 */
export class ItemIndex {
	/** The ends of each item, by item ID: `run:<runId>` and `parley:<slug>`. */
	readonly #ends = new Map<number, readonly string[]>();
	/** The IDs of the items of each end. */
	readonly #items = new Map<string, Set<number>>();
	/** The IDs of the items that a commit changed during the build; nothing once the build is done. */
	#building: Set<number> | undefined = new Set();
	#observation: CommitObservation | undefined;

	/**
	 * Builds the index from the items of `harness`, and keeps it current with its commits.
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
			const items = await allItems(harness, storage, context);
			const changed = index.#building;
			index.#building = undefined;

			for (const item of items) if (!changed?.has(item.id)) index.#set(item);
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

	/** The IDs of the items whose edges come from `end`, a `run:` or a `parley:` reference, in ID order. */
	itemsOf(end: string): number[] {
		return [...(this.#items.get(end) ?? [])].sort((a, b) => a - b);
	}

	/** Applies `changes`, the changes of one commit, and gives the IDs of the items that they change. */
	#advance(changes: readonly CommitChange[]): number[] {
		const documents = changes.filter((change): change is StoredDocumentChange => change.type === "document");

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
}
