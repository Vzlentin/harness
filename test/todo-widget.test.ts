import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";
import { LinesWidget } from "../pi/polled-widget.ts";
import { todoWidgetLines } from "../pi/todo.ts";
import { type Todo, todoLine } from "../src/protocol/index.ts";
import { drawWidget } from "./helpers.ts";

/** A theme that writes `<colour>` before the text, so a test sees what is dim. */
const THEME: Pick<Theme, "fg"> = { fg: (color, text) => `<${color}>${text}` };

/** A theme with no colours, so a test can measure the width of a line. */
const PLAIN: Pick<Theme, "fg"> = { fg: (_color, text) => text };

/** The lines that the todo widget draws at `width` for `todos`, through a real widget in a session with a UI. */
function draw(todos: Todo[], width: number, theme = THEME): readonly string[] {
	const widget = new LinesWidget("todos", "aboveEditor");
	const renders: (readonly string[])[] = [];

	const ctx: Pick<ExtensionContext, "hasUI"> & { readonly ui: Pick<ExtensionContext["ui"], "setWidget"> } = {
		hasUI: true,
		ui: {
			setWidget: (_key: string, content: string[] | ((tui: TUI, piTheme: Theme) => Component) | undefined) => {
				if (content instanceof Function) drawWidget(content, theme, renders, width);
			},
		},
	};

	// SAFETY: the widget reads only these fields of the context.
	widget.start(ctx as ExtensionContext);
	widget.show(todoWidgetLines({ todos }, todoLine, theme));

	return renders.at(-1) ?? [];
}

/** Todos with the IDs from 1 and the state `state`. */
function todosIn(state: Todo["state"], count: number, from = 1): Todo[] {
	return Array.from({ length: count }, (_, index) => ({ id: from + index, text: `Step ${from + index}`, state }));
}

describe("todo widget", () => {
	it("shows a header with the done todos out of all but the dropped ones, then the open and doing todos", () => {
		const todos: Todo[] = [
			...todosIn("done", 3),
			{ id: 4, text: "Not this way", state: "dropped" },
			{ id: 5, text: "Build it", state: "doing" },
			{ id: 6, text: "Ship it", state: "open" },
		];

		expect(draw(todos, 80)).toEqual([" <dim>todos 3/5", " ◉ 5 Build it", " ○ 6 Ship it"]);
	});

	it("cuts a line longer than the width with an ellipsis", () => {
		const todos: Todo[] = [{ id: 1, text: "Write the plan of the whole migration", state: "open" }];
		const lines = draw(todos, 20, PLAIN);

		expect(stripVTControlCharacters(lines[1] ?? "")).toBe(" ○ 1 Write the plan…");
		expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
	});

	it("shows at most 10 lines, the last one with the number of the todos that do not fit", () => {
		const lines = draw([...todosIn("open", 11), ...todosIn("doing", 1, 12)], 80);

		expect(lines).toHaveLength(10);
		expect(lines.at(-2)).toBe(" ○ 8 Step 8");
		expect(lines.at(-1)).toBe(" <dim>+4 more");
	});

	it("draws nothing when no todo is open or doing", () => {
		expect(draw([...todosIn("done", 2), { id: 3, text: "Not this way", state: "dropped" }], 80)).toEqual([]);
		expect(draw([], 80)).toEqual([]);
	});
});
