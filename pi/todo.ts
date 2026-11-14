/**
 * The `todo` tool of a Pi session, and the todo widget above the editor, which shows the list of the agent of the
 * session: the session itself, or the agent that a mirror session shows.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Todo, TodoList } from "../dist/protocol/index.js";
import type { Harness } from "./index.ts";
import { PolledWidget } from "./polled-widget.ts";

/** The most lines that the todo widget shows, with its header. */
const MAX_LINES = 10;

/**
 * The lines of the todo widget for `list`, while one of its todos is open or doing: a dim header `todos <done>/<total>`,
 * whose total leaves out the dropped todos, then the line of each open and doing todo, as `harness todo list` prints
 * it. When they do not fit in `MAX_LINES`, the last line is a dim `+<n> more`. Otherwise none, which hides the widget.
 */
export function todoWidgetLines(
	list: TodoList,
	todoLine: (todo: Todo) => string,
	theme: Pick<Theme, "fg">,
): string[] | undefined {
	const active = list.todos.filter(({ state }) => state === "open" || state === "doing");

	if (active.length === 0) return undefined;
	const done = list.todos.filter(({ state }) => state === "done").length;
	const header = theme.fg("dim", `todos ${done}/${done + active.length}`);

	if (active.length < MAX_LINES) return [header, ...active.map(todoLine)];
	const shown = active.slice(0, MAX_LINES - 2);

	return [header, ...shown.map(todoLine), theme.fg("dim", `+${active.length - shown.length} more`)];
}

/**
 * Registers the `todo` tool, whose caller is the session ID, and gives the todo widget. Its reads get the list of the
 * session as the subagents widget reads the children, and at once after each `todo` call. In a mirror session, nothing
 * reads, and the attachment shows the list of the mirrored agent in its `widget`. `registerMirror` starts the widget at
 * the start of each session, and stops it at the end.
 */
export function registerTodo(pi: ExtensionAPI, harness: Pick<Harness, "client" | "protocol" | "tool">): PolledWidget {
	const { client, protocol, tool } = harness;

	const todos = new PolledWidget(
		"todos",
		"aboveEditor",
		async (ctx) => {
			const caller = ctx.sessionManager.getSessionId();
			const list = await client.request({ type: "todo", caller, action: "list" }, { start: false });

			return list === undefined ? undefined : todoWidgetLines(tool.replyList(list), protocol.todoLine, ctx.ui.theme);
		},
		protocol.errorMessage,
	);

	const { parameters, output } = tool.todoToolSchemas({ Type });
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: tool.TODO_TOOL_DESCRIPTION,
		parameters,
		outputSchema: output,
		// Each call has its own connection, so calls at the same time can reach the host out of order.
		executionMode: "sequential",
		async execute(_toolCallId, args, signal, _onUpdate, ctx) {
			const scope = { caller: ctx.sessionManager.getSessionId(), send: tool.sendToHost, signal };
			const { text, data } = await tool.runTodoTool(args, scope, tool.todoToolTarget(args));
			await todos.refresh();

			return { content: [{ type: "text", text }], details: undefined, structuredContent: data };
		},
	});

	return todos;
}
