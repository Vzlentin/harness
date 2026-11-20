/**
 * `store.json`: the host writes the lists and the items of the store of the project to it at its start and after each
 * commit that changes one, so a program can read them with no host and no store.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, Storage } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { writeJsonFile } from "../protocol/json-file.ts";
import { errorMessage } from "../protocol/requests.ts";
import { type FileMessage, STORE_FILE_VERSION, type StoreFile } from "../protocol/store-file.ts";
import { allItems, ItemCounterDoc, itemChange } from "./item-docs.ts";
import { CommitPasses } from "./passes.ts";
import { readLastRuleId, readRules } from "./project-rules.ts";
import {
	type OutState,
	projectChange,
	readAsks,
	readHeld,
	readOutbox,
	readParleys,
	readPersons,
	readStored,
	readThreads,
	type StoredMessage,
} from "./project.ts";
import { readCallerTodos, readTodos, todoListChange } from "./todo.ts";

const context = BACKGROUND_CONTEXT;

/** What the file uses of the host. */
export type StoreFileHost = {
	readonly harness: Harness;
	/**
	 * The storage of `harness`, whose scan lists the items and the callers that have a list of todos, and whose entry
	 * lookup gives the thread of the source of an older rule.
	 */
	readonly storage: Pick<Storage, "scanDocuments" | "entry">;
	/** The root conversation, whose list is the list of the project. */
	readonly root: Conversation;
	/** The file, `store.json` in the state folder of the project. */
	readonly path: string;
	readonly warn: (cause: unknown) => void;
};

/**
 * The passes that write the file at once, and again after each commit that changes a list. A write that fails gives one
 * warning and does not fail the commit. `close()` stops the passes and waits for the write in progress.
 */
export function storeFilePasses(host: StoreFileHost): CommitPasses {
	return new CommitPasses(
		host.harness,
		(change) => projectChange(change) || todoListChange(change, host.root.id) || itemChange(change),
		() =>
			readStoreFile(host.harness, host.storage, host.root.id)
				.then((file) => writeJsonFile(host.path, file))
				.catch((cause: unknown) => host.warn(`Could not write ${host.path}: ${errorMessage(cause)}`)),
	);
}

/**
 * Every list of the file, as the store of `harness` has them now, with the list of the project from the root
 * conversation `root`. `storage`, the storage of `harness`, lists the items and the callers that have a list of todos,
 * and gives the thread of the source of an older rule. A store with no counter of the IDs of items has `lastItem` 0.
 */
export async function readStoreFile(
	harness: Harness,
	storage: Pick<Storage, "scanDocuments" | "entry">,
	root: ConversationId,
): Promise<StoreFile> {
	const [persons, threads, rules, lastRule, held, parleys, asks] = await Promise.all([
		readPersons(harness, context),
		readThreads(harness, context),
		readRules({ harness, storage }, {}, context),
		readLastRuleId(harness, context),
		readHeld(harness, context),
		readParleys(harness, context),
		readAsks(harness, context),
	]);

	const stored = await Promise.all(
		threads.threads.map(async (thread) => ({ thread, messages: await readStored(harness, thread.id, context) })),
	);

	// The outbox is read after the messages, so that each message out that they have has its state there.
	const outbox = new Map((await readOutbox(harness, context)).map((out) => [out.id, out]));
	const todos = await readTodos(harness, { kind: "conversation", id: root }, context);
	const callerTodos = await readCallerTodos(harness, storage, context);
	const items = await allItems(harness, storage, context);
	const counter = await harness.snapshot(ItemCounterDoc, context);

	return {
		version: STORE_FILE_VERSION,
		persons: persons.persons,
		threads: stored.map(({ thread, messages }) => ({
			...thread,
			messages: messages.map((message) => fileMessage(message, outbox)),
		})),
		rules: rules.rules,
		lastRule,
		held: held.held,
		parleys: parleys.parleys,
		asks: asks.asks,
		todos: todos.todos,
		callerTodos,
		items: items.map((item) => Value.Clone(item)),
		lastItem: counter?.last ?? 0,
	};
}

/**
 * The message `message` of the file: `received` for a message in, and for a message out its state and the last change
 * of its state in `outbox`, by message ID. A message out with no state in the outbox fails.
 */
function fileMessage(message: StoredMessage, outbox: ReadonlyMap<number, OutState>): FileMessage {
	if (message.direction === "in") return { ...message, direction: "in", state: "received" };
	const out = outbox.get(message.id);

	if (out === undefined) throw new Error(`Message ${message.id} is a message out with no state in the outbox`);

	return { ...message, direction: "out", state: out.state, changed: { at: out.at, by: out.by } };
}
