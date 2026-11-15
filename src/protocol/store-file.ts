/**
 * `store.json`: the lists of the store of a project, which the host writes whole after each commit that changes one.
 */
import { type Static, Type } from "typebox";
import { Ask, HeldAction, Message, Parley, Person, Rule, Thread } from "./project.ts";
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
