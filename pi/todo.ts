/**
 * The `todo` tool of a Pi session, and the todo widget below the editor, which shows the list of the agent of the
 * session: the session itself, or the agent that a mirror session shows.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Todo, TodoList } from "../dist/protocol/index.js";
import type { Harness } from "./index.ts";
import { PolledWidget } from "./polled-widget.ts";

/** The key of the todo widget below the editor. */
export const TODO_WIDGET = "todos";

/**
 * The lines of the todo widget for `list`: the line of each todo, as `harness todo list` prints it, while one of them
 * is open or doing. Otherwise none, which hides the widget.
 */
export function todoWidgetLines(list: TodoList, todoLine: (todo: Todo) => string): string[] | undefined {
	const active = list.todos.some(({ state }) => state === "open" || state === "doing");

	return active ? list.todos.map(todoLine) : undefined;
}

/**
 * Registers the `todo` tool, whose caller is the session ID, and the todo widget of a session that is not a mirror
 * session (`mirrored` tells, after the `session_start` of the mirror). The widget reads the list of the session as the
 * subagents widget reads the children, and at once after each `todo` call. A mirror session shows the list of its agent
 * in its attachment.
 */
export function registerTodo(
	pi: ExtensionAPI,
	harness: Pick<Harness, "client" | "protocol" | "tool">,
	mirrored: () => boolean,
): void {
	const { client, protocol, tool } = harness;

	const widget = new PolledWidget(
		TODO_WIDGET,
		async (ctx) => {
			const caller = ctx.sessionManager.getSessionId();
			const list = await client.request({ type: "todo", caller, action: "list" }, { start: false });

			return list === undefined ? undefined : todoWidgetLines(tool.replyList(list), protocol.todoLine);
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
			const caller = ctx.sessionManager.getSessionId();
			const { text, data } = await tool.runTodoTool(args, { caller, send: tool.sendToHost, signal });
			await widget.refresh();

			return { content: [{ type: "text", text }], details: undefined, structuredContent: data };
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!mirrored()) widget.start(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		widget.stop(ctx);
	});
}
