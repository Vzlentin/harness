/**
 * `store.json`: the host writes the lists of the store of the project to it at its start and after each commit that
 * changes one, so a program can read them with no host and no store.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness, Storage } from "@earendil-works/pi-durable";
import { writeJsonFile } from "../protocol/json-file.ts";
import { errorMessage } from "../protocol/requests.ts";
import { type FileMessage, STORE_FILE_VERSION, type StoreFile } from "../protocol/store-file.ts";
import { CommitPasses } from "./passes.ts";
import {
	type OutState,
	projectChange,
	readAsks,
	readHeld,
	readLastRuleId,
	readOutbox,
	readParleys,
	readPersons,
	readRules,
	readStored,
	readThreads,
	type StoredMessage,
} from "./project.ts";
import { readCallerTodos, readTodos, todoListChange } from "./todo.ts";

const context = BACKGROUND_CONTEXT;

/** What the file uses of the host. */
export type StoreFileHost = {
	readonly harness: Harness;
	/** The storage of `harness`, whose scan lists the callers that have a list of todos. */
	readonly storage: Pick<Storage, "scanDocuments">;
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
		(change) => projectChange(change) || todoListChange(change, host.root.id),
		() =>
			readStoreFile(host)
				.then((file) => writeJsonFile(host.path, file))
				.catch((cause: unknown) => host.warn(`Could not write ${host.path}: ${errorMessage(cause)}`)),
	);
}

/** Every list of the file, as the store has them now. */
async function readStoreFile(host: StoreFileHost): Promise<StoreFile> {
	const { harness, root } = host;

	const [persons, threads, rules, lastRule, held, parleys, asks] = await Promise.all([
		readPersons(harness, context),
		readThreads(harness, context),
		readRules(harness, {}, context),
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
	const todos = await readTodos(harness, { kind: "conversation", id: root.id }, context);
	const callerTodos = await readCallerTodos(harness, host.storage, context);

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
