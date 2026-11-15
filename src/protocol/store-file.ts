/**
 * `store.json`: the lists of the store of a project, which the host writes whole after each commit that changes one.
 */
import { readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { Ask, HeldAction, Message, Parley, Person, Rule, Thread } from "./project.ts";
import { errorMessage } from "./requests.ts";
import { Todo } from "./todo.ts";

/** The version of the shape of `store.json`. */
export const STORE_FILE_VERSION = 1;

/** The last change of the state of a message out: its time, and the caller of the change. */
export const StateChange = Type.Object({ at: Message.properties.at, by: Message.properties.by });

/**
 * A message of the file, with its state. A message out also has `changed`, the last change of its state; a message in
 * has none.
 */
export const FileMessage = Type.Union([
	Type.Object({ ...Message.properties, direction: Type.Literal("in"), changed: Type.Optional(Type.Never()) }),
	Type.Object({ ...Message.properties, direction: Type.Literal("out"), changed: StateChange }),
]);

export type FileMessage = Static<typeof FileMessage>;

/**
 * The lists of the store: the persons, the threads with their messages, oldest first, the rules and the highest ID that
 * a rule had, the held actions, the parleys, the asks, the todos of the project agent, and the todos of each caller
 * that is not a conversation of the host, in caller order. The state of each message out is in its message.
 */
export const StoreFile = Type.Object({
	version: Type.Literal(STORE_FILE_VERSION),
	persons: Type.Array(Person),
	threads: Type.Array(Type.Object({ ...Thread.properties, messages: Type.Array(FileMessage) })),
	rules: Type.Array(Rule),
	lastRule: Type.Integer({ minimum: 0 }),
	held: Type.Array(HeldAction),
	parleys: Type.Array(Parley),
	asks: Type.Array(Ask),
	todos: Type.Array(Todo),
	callerTodos: Type.Array(Type.Object({ caller: Type.String(), todos: Type.Array(Todo) })),
});

export type StoreFile = Static<typeof StoreFile>;

/** The count of each list of a store file, in the order of the lines of `harness store load`. */
export type StoreCounts = {
	persons: number;
	threads: number;
	messages: number;
	rules: number;
	held: number;
	parleys: number;
	asks: number;
	/** The messages out, each with its state in the outbox. */
	outbox: number;
	todos: number;
	/** The todos of all the callers. */
	callerTodos: number;
};

const Versioned = Type.Object({ version: Type.Unknown() });

/**
 * The store file at `path`. It fails with one line when the file is not JSON, has another version, does not match the
 * schema, has an ID twice in one list (the messages of all threads are one list), has a caller twice in `callerTodos`,
 * or has a reference that does not resolve: a message that is not in the thread that it names, or a rule whose source
 * is no message of the file.
 */
export function parseStoreFile(path: string): StoreFile {
	let value: unknown;

	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not a store file: ${errorMessage(error)}`, { cause: error });
	}

	if (Value.Check(Versioned, value) && value.version !== STORE_FILE_VERSION) {
		throw new Error(
			`${path} has the version ${JSON.stringify(value.version)}: harness store load reads only the version ${STORE_FILE_VERSION}`,
		);
	}

	if (!Value.Check(StoreFile, value)) {
		const [error] = Value.Errors(StoreFile, value);

		throw new Error(
			`${path} is not a store file: ${[error?.instancePath, error?.message].filter((part) => part).join(" ")}`,
		);
	}

	const broken = brokenReference(value);

	if (broken !== undefined) throw new Error(`${path} is not a store file: ${broken}`);

	return value;
}

/** The first value of `values` that is there twice, or undefined when each one is there once. */
function twice<T>(values: readonly T[]): T | undefined {
	const seen = new Set<T>();

	for (const value of values) {
		if (seen.has(value)) return value;
		seen.add(value);
	}

	return undefined;
}

/** The first list of `file` that has an ID twice, as a reason, or undefined when each ID is there once. */
function duplicateId(file: StoreFile): string | undefined {
	const ids = (items: readonly { id: number }[]) => items.map((item) => item.id);

	const lists: [string, readonly number[]][] = [
		["persons", ids(file.persons)],
		["threads", ids(file.threads)],
		["messages", file.threads.flatMap((thread) => ids(thread.messages))],
		["rules", ids(file.rules)],
		["held", ids(file.held)],
		["parleys", ids(file.parleys)],
		["asks", ids(file.asks)],
		["todos", ids(file.todos)],
		...file.callerTodos.map((list): [string, readonly number[]] => [`todos of ${list.caller}`, ids(list.todos)]),
	];

	for (const [name, list] of lists) {
		const id = twice(list);

		if (id !== undefined) return `the ${name} have the ID ${id} twice`;
	}

	const caller = twice(file.callerTodos.map((list) => list.caller));

	return caller === undefined ? undefined : `callerTodos has the caller ${caller} twice`;
}

/** The first ID that is there twice or reference of `file` that does not resolve, or undefined when there is none. */
function brokenReference(file: StoreFile): string | undefined {
	const duplicate = duplicateId(file);

	if (duplicate !== undefined) return duplicate;
	const messages = new Set<number>();

	for (const thread of file.threads) {
		for (const message of thread.messages) {
			if (message.thread !== thread.id)
				return `message ${message.id} names the thread ${message.thread}, not ${thread.id}`;
			messages.add(message.id);
		}
	}

	const rule = file.rules.find((found) => found.source !== undefined && !messages.has(found.source));

	return rule === undefined ? undefined : `the source of the rule ${rule.id} is no message of the file`;
}

/** The count of each list of `file`. */
export function storeCounts(file: StoreFile): StoreCounts {
	return {
		persons: file.persons.length,
		threads: file.threads.length,
		messages: file.threads.reduce((sum, thread) => sum + thread.messages.length, 0),
		rules: file.rules.length,
		held: file.held.length,
		parleys: file.parleys.length,
		asks: file.asks.length,
		outbox: file.threads.reduce(
			(sum, thread) => sum + thread.messages.filter((message) => message.direction === "out").length,
			0,
		),
		todos: file.todos.length,
		callerTodos: file.callerTodos.reduce((sum, list) => sum + list.todos.length, 0),
	};
}
