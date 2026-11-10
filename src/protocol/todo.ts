import { type Static, Type } from "typebox";

/** The states of a todo. */
export const TODO_STATES = ["open", "doing", "done", "dropped"] as const;

/** One of the states of a todo. */
export const TodoState = Type.Enum(TODO_STATES);

export type TodoState = Static<typeof TodoState>;

/** A line of intent with a state. Its ID is its place in its list: 1, 2, 3 and so on. */
export const Todo = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	text: Type.String({ pattern: "\\S" }),
	state: TodoState,
});

export type Todo = Static<typeof Todo>;

/** One list of todos, in ID order. */
export type TodoList = { todos: Todo[] };
