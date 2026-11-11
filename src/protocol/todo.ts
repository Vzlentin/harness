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

/** The kind of the document of the list of a conversation, in the store and in the `docs` of a watched view. */
export const TODO_LIST_KIND = "harness.todos";

/** The kind of the documents of the lists of the started tasks, keyed by task ID, in the store. */
export const TASK_TODO_LIST_KIND = "harness.task-todos";

/** One list of todos, in ID order. */
export type TodoList = { todos: Todo[] };

/** The mark of each state in the line of a todo. */
export const TODO_MARKS = {
	open: "○",
	doing: "◉",
	done: "✓",
	dropped: "✗",
} as const satisfies Record<TodoState, string>;

/** The line of `todo` in a list: `<mark> <id> <text>`, with the mark of its state. */
export function todoLine(todo: Todo): string {
	return `${TODO_MARKS[todo.state]} ${todo.id} ${todo.text}`;
}

/**
 * What the classifier says of one open todo: whether it needs a call that only the user can make, and the ID of an
 * earlier todo of its list that it repeats.
 */
export const TodoAnswer = Type.Object({
	id: Todo.properties.id,
	needsYou: Type.Boolean(),
	repeats: Type.Optional(Todo.properties.id),
});

export type TodoAnswer = Static<typeof TodoAnswer>;

/** The reply of `classify-todos`: one answer for each todo that it asked about, in ID order. */
export const ClassifyReply = Type.Object({ answers: Type.Array(TodoAnswer) });

export type ClassifyReply = Static<typeof ClassifyReply>;

/** The line of `answer`: `<id>  needs you: yes|no  repeats: <id>|none`. */
export function answerLine(answer: TodoAnswer): string {
	return `${answer.id}  needs you: ${answer.needsYou ? "yes" : "no"}  repeats: ${answer.repeats ?? "none"}`;
}
