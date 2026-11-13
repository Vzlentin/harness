/**
 * The view of `/vc` over the transcript: its modes (blocks, ranges, search and inline code), the routing of the keys
 * and the mouse, the paint of the selection, and the scroll that reveals it.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	matchesKey,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { blockRows, type Copy, type CopyResult, type Paint, selectionCopies } from "./copy-choice.ts";
import { type Action, action, type Hint, rowNeighbor, statusLine } from "./copy-keys.ts";
import { highlightLine, type Range, type Style } from "./terminal-text.ts";
import {
	baseRender,
	type Block,
	buildLayout,
	contentWidth,
	findMatches,
	isGone,
	isTool,
	type Layout,
	type Match,
	nextMatch,
	offsetOf,
	type Owner,
	ownerRows,
	type Position,
	type Rows,
	type ScrollViewNode,
	scrollViewOf,
	type Span,
	spanRanges,
} from "./transcript.ts";

/** The query while the user types it after `/` or `?`, and the cursor before the search started. */
interface Search {
	query: string;
	origin: number;
	backward: boolean;
}

type BlocksMode = { kind: "blocks"; anchor?: number | undefined; search?: Search | undefined };

type Mode = BlocksMode | { kind: "code"; index: number };

/**
 * The selection. `rows` are the rows in `owner` that reveal shows, and `focus` is a row that reveal centers when the
 * rows do not fit in the view.
 */
interface Target {
	owner: Owner;
	rows?: Rows | undefined;
	focus?: number | undefined;
	paint: Paint;
	copy: Copy;
	copyAlt: Copy;
	hints: Hint[];
}

const RAW_FLASH_MS = 150;

// oxlint-disable-next-line no-control-regex -- the bar slot follows the OSC sequences of the line.
const BAR_SLOT = /^((?:\x1b\][^\x07]*\x07)*) /;

// oxlint-disable-next-line no-control-regex -- a reset is an SGR sequence, which starts with ESC.
const RESET = /\x1b\[(?:0|49)?m/g;

// oxlint-disable-next-line no-control-regex -- a printable key has no control character.
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;

/**
 * A mouse drag from a block. `viewTop` is the screen row of the first row of the transcript view, so the drag still
 * finds the blocks when the view scrolls.
 */
interface Drag {
	from: number;
	viewTop: number;
	owners: Map<Owner, [number, number]>;
}

/** The view of `/vc`. It gives the copy that the user chose to `done`, or undefined when the user leaves. */
export class VisualCopy implements Component {
	private cursor: number;
	private drag: Drag | undefined;
	private mode: Mode = { kind: "blocks" };
	private pendingReveal = true;
	private query = "";
	private backward = false;
	private matches: Match[] = [];
	private current: Match | undefined;
	private notice: { text: string; error: boolean } | undefined;
	private flash: Paint | undefined;
	private cache: { width: number; layout: Layout } | undefined;
	// The columns of the selected span, found one time for each selection.
	private spanPaint: { span: Span; ranges: Array<Range & { row: number }> } | undefined;
	private readonly owners: Set<Owner>;
	private readonly matchStyles: { other: Style; current: Style };
	private readonly spanStyle: Style;
	private readonly background: Style;
	private readonly scrollView: ScrollViewNode | undefined;
	private readonly savedScroll: number | "end" | undefined;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly blocks: Block[];
	private readonly done: (result: CopyResult | undefined) => void;

	/** `blocks` has at least one block. */
	constructor(tui: TUI, theme: Theme, blocks: Block[], done: (result: CopyResult | undefined) => void) {
		this.tui = tui;
		this.theme = theme;
		this.blocks = blocks;
		this.done = done;
		this.scrollView = scrollViewOf(tui);
		this.savedScroll = this.scrollView?.isFollowingEnd ? "end" : this.scrollView?.scrollTop;
		this.cursor = this.savedScroll === "end" ? blocks.length - 1 : (this.visibleBlock() ?? blocks.length - 1);
		const [open = "", close = ""] = theme.bg("selectedBg", "\u0000").split("\u0000");
		this.background = [open, close];

		this.matchStyles = {
			other: ["\x1b[7m", "\x1b[27m"],
			current: [theme.getFgAnsi("warning").replace("[38;", "[48;") + "\x1b[30m", "\x1b[39m\x1b[49m"],
		};

		this.spanStyle = [theme.getFgAnsi("accent").replace("[38;", "[48;") + "\x1b[30m", "\x1b[39m\x1b[49m"];
		this.owners = new Set(blocks.map((b) => b.owner));

		for (const owner of this.owners) {
			owner.render = (width) => this.decorate(owner, baseRender(owner, width));
			owner.handleMouse = (event) => this.ownerMouse(owner, event);
		}
	}

	dispose(): void {
		for (const owner of this.owners) {
			Reflect.deleteProperty(owner, "render");
			Reflect.deleteProperty(owner, "handleMouse");
		}

		if (this.savedScroll === "end") this.scrollView?.scrollToEnd();
		else if (this.savedScroll !== undefined) this.scrollView?.scrollTo(this.savedScroll);
		this.tui.requestRender();
	}

	invalidate(): void {}

	/** The block at `index`, which the cursor, a range or a match gives, so it exists. */
	private block(index: number): Block {
		const block = this.blocks[index];

		if (!block) throw new Error(`/vc has no block ${index}`);

		return block;
	}

	/** Gives the last block that shows in full in the transcript view, or else the last block that shows in part. */
	private visibleBlock(): number | undefined {
		const view = this.scrollView;

		if (!view) return undefined;
		const layout = this.layout();
		const owners = ownerRows(view.child, layout.width);
		const top = view.scrollTop;
		const bottom = top + view.viewportHeight - 1;
		let partial: number | undefined;

		for (let i = this.blocks.length - 1; i >= 0; i--) {
			const rows = layout.rows[i];
			const at = owners.get(this.block(i).owner)?.[0];

			if (!rows || at === undefined || at + rows[0] > bottom || at + rows[1] < top) continue;

			if (at + rows[0] >= top && at + rows[1] <= bottom) return i;
			partial ??= i;
		}

		return partial;
	}

	/** Gives the innermost block at a row of the owner. */
	private blockAt(layout: Layout, owner: Owner, row: number): number | undefined {
		let found: number | undefined;
		let size = Infinity;

		for (let i = 0; i < this.blocks.length; i++) {
			const rows = layout.rows[i];

			if (this.block(i).owner !== owner || !rows || row < rows[0] || row > rows[1]) continue;

			if (rows[1] - rows[0] <= size) {
				found = i;
				size = rows[1] - rows[0];
			}
		}

		return found;
	}

	/**
	 * A click selects the block under the pointer, or the code span in code mode. Shift+click and a drag select a range,
	 * and a double click copies. Other mouse events, such as the wheel, go to the transcript.
	 */
	private ownerMouse(owner: Owner, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || !["press", "drag", "release", "click"].includes(event.type)) return undefined;

		if (this.flash || (this.mode.kind === "blocks" && this.mode.search)) return { handled: true };
		const layout = this.layout();

		if (event.type === "release") {
			this.drag = undefined;

			return { handled: true };
		}

		if (event.type === "click") {
			if (event.clickCount === 2) this.copy(this.target(layout).copy);

			return { handled: true };
		}

		if (event.type === "drag") {
			this.dragTo(layout, event);

			return { handled: true };
		}

		this.notice = undefined;
		this.drag = undefined;

		if (this.mode.kind === "code") {
			const after = (p: Position) => event.y > p[0] || (event.y === p[0] && event.x >= p[1]);
			const span = layout.spans.findIndex((s) => s.owner === owner && after(s.start) && !after(s.end));

			if (span !== -1) {
				this.selectSpan(layout, span);

				return { handled: true };
			}
		}

		const block = this.blockAt(layout, owner, event.y);

		if (block === undefined) return { handled: true };
		const anchor = event.shift && this.mode.kind === "blocks" ? (this.mode.anchor ?? this.cursor) : undefined;
		this.mode = { kind: "blocks", anchor: anchor === block ? undefined : anchor };
		this.move(block);

		if (this.scrollView) {
			const owners = ownerRows(this.scrollView.child, layout.width);
			const at = owners.get(owner)?.[0] ?? 0;
			this.drag = { from: anchor ?? block, viewTop: event.screenY - event.y - at + this.scrollView.scrollTop, owners };
		}

		return { capture: true };
	}

	/** Moves the cursor of a drag to the block under the pointer, and keeps the range from the block of the press. */
	private dragTo(layout: Layout, event: TuiMouseEvent): void {
		if (!this.drag || !this.scrollView || this.mode.kind !== "blocks") return;
		const row = event.screenY - this.drag.viewTop + this.scrollView.scrollTop;

		for (const [other, [at, height]] of this.drag.owners) {
			if (row < at || row >= at + height || !this.owners.has(other)) continue;
			const block = this.blockAt(layout, other, row - at);

			if (block === undefined || block === this.cursor) break;
			this.mode.anchor = block === this.drag.from ? undefined : this.drag.from;
			this.move(block);
			break;
		}
	}

	/**
	 * Gives the layout at the width of the transcript. A new width or a replaced Markdown node makes a new layout, and
	 * the matches follow it.
	 */
	private layout(): Layout {
		const width = contentWidth(this.tui);
		const cached = this.cache;

		if (cached?.width === width && !cached.layout.rows.some((rows, i) => rows && isGone(this.block(i)))) {
			return cached.layout;
		}

		const layout = buildLayout(this.blocks, width);
		this.cache = { width, layout };
		this.matches = findMatches(layout, this.activeQuery());

		return layout;
	}

	private activeQuery(): string {
		return this.mode.kind === "blocks" && this.mode.search ? this.mode.search.query : this.query;
	}

	handleInput(data: string): void {
		if (this.flash) return;
		const layout = this.layout();

		if (this.mode.kind === "blocks" && this.mode.search) {
			this.handleSearchInput(layout, this.mode, this.mode.search, data);

			return;
		}

		const act = action(data);
		this.notice = undefined;

		if (!act) return;

		if (act === "quit") {
			this.done(undefined);

			return;
		}

		// A new layout can have no spans, and then the view shows and handles block mode.
		if (this.mode.kind === "code" && layout.spans.length === 0) this.mode = { kind: "blocks" };

		if (act === "copy" || act === "copyAlt") {
			const target = this.target(layout);
			this.copy(act === "copy" ? target.copy : target.copyAlt);

			return;
		}

		const moved =
			this.mode.kind === "code"
				? this.codeAction(layout, this.mode.index, act)
				: this.blockAction(layout, this.mode, act);

		if (moved) this.tui.requestRender();
	}

	private copy(copy: Copy): void {
		if (!copy.flash) {
			this.done(copy.result);

			return;
		}

		this.flash = copy.flash;
		setTimeout(() => this.done(copy.result), RAW_FLASH_MS);
		this.tui.requestRender();
	}

	/**
	 * In code mode, h and l go to the previous and next span, and j and k go to the span on the next or previous row that
	 * is nearest to the column of the selected span.
	 */
	private codeAction(layout: Layout, selected: number, act: Action): boolean {
		const spans = layout.spans;
		const index = Math.min(selected, spans.length - 1);
		let next: number | undefined;

		switch (act) {
			case "back":
			case "code":
				this.mode = { kind: "blocks" };
				this.move(spans[index]?.block ?? this.cursor);

				return true;
			case "left":
				next = Math.max(index - 1, 0);
				break;
			case "right":
				next = Math.min(index + 1, spans.length - 1);
				break;
			case "down":
			case "up":
				next = rowNeighbor(spans, index, act === "down" ? 1 : -1);
				break;
			case "top":
				next = 0;
				break;
			case "bottom":
				next = spans.length - 1;
				break;
		}

		if (next === undefined) return false;
		this.selectSpan(layout, next);

		return true;
	}

	private selectSpan(layout: Layout, index: number): void {
		this.mode = { kind: "code", index };
		this.move(layout.spans[index]?.block ?? this.cursor);
	}

	private blockAction(layout: Layout, mode: BlocksMode, act: Action): boolean {
		const last = this.blocks.length - 1;
		const message = this.block(this.cursor).message;
		const messageStart = (m: number) => this.blocks.findIndex((b) => b.message === m);
		const nextMessage = this.blocks.findIndex((b) => b.message > message);

		switch (act) {
			case "back":
				if (mode.anchor === undefined) {
					this.done(undefined);

					return false;
				}

				mode.anchor = undefined;

				return true;
			case "down":
				this.move(Math.min(this.cursor + 1, last));

				return true;
			case "up":
				this.move(Math.max(this.cursor - 1, 0));

				return true;
			case "nextMessage":
				this.move(nextMessage === -1 ? last : nextMessage);

				return true;
			case "prevMessage": {
				const start = messageStart(message);
				this.move(this.cursor > start || message === 0 ? start : messageStart(message - 1));

				return true;
			}

			case "top":
				this.move(0);

				return true;
			case "bottom":
				this.move(last);

				return true;
			case "search":
			case "searchBack":
				mode.search = { query: "", origin: this.cursor, backward: act === "searchBack" };
				this.matches = [];
				this.current = undefined;

				return true;
			case "next":
			case "prev":
				if (!this.query) return false;
				this.jump(this.query, this.backward !== (act === "prev"), this.cursor, mode.anchor !== undefined);

				return true;
			case "range":
				mode.anchor = mode.anchor === undefined ? this.cursor : undefined;

				return true;
			case "messageRange":
				mode.anchor = messageStart(message);
				this.move(nextMessage === -1 ? last : nextMessage - 1);

				return true;
			case "code":
				this.enterCode(layout);

				return true;
			default:
				return false;
		}
	}

	/** Selects the first code span in or after the cursor block, or the last one when there is none. */
	private enterCode(layout: Layout): void {
		const spans = layout.spans;

		if (spans.length === 0) {
			this.notice = { text: "No inline code in agent messages", error: true };

			return;
		}

		const next = spans.findIndex((s) => s.block >= this.cursor);
		this.selectSpan(layout, next === -1 ? spans.length - 1 : next);
	}

	/** While the user types, the cursor goes to the first match from the start position, as Vim incsearch does. */
	private handleSearchInput(layout: Layout, mode: BlocksMode, search: Search, data: string): void {
		const key = decodeKittyPrintable(data) ?? data;

		if (matchesKey(data, "escape") || (matchesKey(data, "backspace") && !search.query)) {
			mode.search = undefined;
			this.notice = undefined;
			this.matches = findMatches(layout, this.query);
			this.move(search.origin);
		} else if (matchesKey(data, "enter")) {
			mode.search = undefined;
			this.backward = search.backward;

			// An empty query repeats the last search, as in Vim.
			if (search.query) {
				this.query = search.query;
			} else {
				this.matches = findMatches(layout, this.query);

				if (this.query) this.jump(this.query, search.backward, search.origin);
			}
		} else if (matchesKey(data, "backspace")) {
			search.query = Array.from(search.query).slice(0, -1).join("");
			this.incremental(layout, search);
		} else if (PRINTABLE.test(key)) {
			search.query += key;
			this.incremental(layout, search);
		} else {
			return;
		}

		this.tui.requestRender();
	}

	private incremental(layout: Layout, search: Search): void {
		this.notice = undefined;
		this.matches = findMatches(layout, search.query);

		if (search.query) this.jump(search.query, search.backward, search.origin);
		else this.move(search.origin);
	}

	/** The current match is a match object, so a new layout, which makes new matches, has no current match. */
	private currentIndex(): number {
		return this.current ? this.matches.indexOf(this.current) : -1;
	}

	private jump(query: string, backward: boolean, origin: number, byBlock = false): void {
		const current = this.currentIndex();
		const next = nextMatch(this.matches, current === -1 ? undefined : current, origin, backward, byBlock);
		const match = next === undefined ? undefined : this.matches[next.index];

		if (!next || !match) {
			this.notice = { text: `Pattern not found: ${query}`, error: true };
			this.move(origin);

			return;
		}

		if (next.wrapped) {
			const text = backward ? "search hit TOP, continuing at BOTTOM" : "search hit BOTTOM, continuing at TOP";
			this.notice = { text, error: false };
		}

		this.move(match.block, match);
	}

	private move(target: number, match?: Match): void {
		this.cursor = target;
		this.current = match;
		this.pendingReveal = true;
	}

	private target(layout: Layout): Target {
		const spans = layout.spans;
		const span = this.mode.kind === "code" ? spans[Math.min(this.mode.index, spans.length - 1)] : undefined;

		if (span) return this.spanTarget(span);

		return this.blockTarget(layout, this.mode.kind === "blocks" ? this.mode.anchor : undefined);
	}

	private spanTarget(span: Span): Target {
		const paint: Paint = (layout, owner, lines) => {
			if (owner !== span.owner) return lines;

			if (this.spanPaint?.span !== span) this.spanPaint = { span, ranges: spanRanges(layout, span) };
			const result = lines.slice();

			for (const { row, start, end } of this.spanPaint.ranges) {
				const line = result[row];

				if (line !== undefined) result[row] = highlightLine(line, [{ start, end, style: this.spanStyle }]);
			}

			return result;
		};

		return {
			owner: span.owner,
			rows: [span.start[0], span.end[0]],
			paint,
			copy: { result: { kind: "text", text: span.text } },
			copyAlt: { result: { kind: "text", text: span.raw } },
			hints: [
				["h/l", "prev/next"],
				["j/k", "row"],
				["y", "copy"],
				["Y", "copy with backticks"],
				["w/esc", "blocks"],
			],
		};
	}

	private blockTarget(layout: Layout, anchor: number | undefined): Target {
		const from = Math.min(anchor ?? this.cursor, this.cursor);
		const to = Math.max(anchor ?? this.cursor, this.cursor);

		const paint =
			(inner: boolean): Paint =>
			(at, owner, lines) =>
				this.paintBlocks(at, owner, lines, from, to, inner);

		const { copy, copyAlt, hints: copyHints, inner } = selectionCopies(this.blocks, from, to, paint(false));

		const current = this.matches[this.currentIndex()];
		const focus = current?.block === this.cursor ? current.row : undefined;

		const hints: Hint[] = [
			["j/k", "block"],
			["{/}", "msg"],
			["v", "range"],
			["V", "msg range"],
			["/ ?", "search"],
			["w", "code"],
		];

		if (this.query) hints.push(["n/N", anchor === undefined ? "next/prev" : "next/prev block"]);
		hints.push(...copyHints, ["esc", "exit"]);

		return {
			owner: this.block(this.cursor).owner,
			rows: blockRows(this.blocks, layout, this.cursor, inner),
			focus,
			paint: paint(inner),
			copy,
			copyAlt,
			hints,
		};
	}

	render(width: number): string[] {
		const layout = this.layout();

		if (this.pendingReveal) {
			this.pendingReveal = false;
			this.reveal(layout);
		}

		const theme = this.theme;
		const block = this.block(this.cursor);
		const count = this.matches.length;
		const current = this.currentIndex();
		const counter = count === 0 ? "" : theme.fg("muted", ` [${current === -1 ? "-" : current + 1}/${count}]`);
		const notice = this.notice ? "  " + theme.fg(this.notice.error ? "error" : "warning", this.notice.text) : "";
		const mode = this.mode;

		if (mode.kind === "blocks" && mode.search) {
			const prompt = theme.fg("accent", mode.search.backward ? "?" : "/") + mode.search.query + theme.inverse(" ");

			return statusLine(theme, width, ` ${prompt}${counter}${notice}`, [
				["enter", "keep"],
				["esc", "cancel"],
			]);
		}

		const target = this.target(layout);
		const spans = layout.spans;
		const index = mode.kind === "code" ? Math.min(mode.index, spans.length - 1) : -1;
		const span = spans[index];

		if (span) {
			const position = theme.fg(
				"muted",
				`code ${index + 1}/${spans.length} · msg ${this.block(span.block).message + 1}`,
			);

			return statusLine(
				theme,
				width,
				`${theme.fg("success", theme.bold(" CODE "))} ${position}${notice}`,
				target.hints,
			);
		}

		const anchor = mode.kind === "blocks" ? mode.anchor : undefined;
		const inMessage = this.blocks.filter((b) => b.message === block.message);

		const label =
			anchor === undefined
				? theme.fg("accent", theme.bold(" COPY "))
				: theme.fg("warning", theme.bold(` VISUAL ${Math.abs(this.cursor - anchor) + 1} `));

		const position = theme.fg(
			"muted",
			`msg ${block.message + 1}/${this.block(this.blocks.length - 1).message + 1}` +
				` · block ${inMessage.indexOf(block) + 1}/${inMessage.length}`,
		);

		const searchState = this.query ? theme.fg("muted", `  ${this.backward ? "?" : "/"}${this.query}`) + counter : "";

		return statusLine(theme, width, `${label} ${position}${searchState}${notice}`, target.hints);
	}

	/** Marks each match in the message rows, and the current match in its own color. */
	private highlight(owner: Owner, lines: string[]): string[] {
		const rows = new Map<number, Array<Range & { style: Style }>>();

		for (const match of this.matches) {
			if (match.owner !== owner) continue;
			const style = match === this.current ? this.matchStyles.current : this.matchStyles.other;
			const ranges = rows.get(match.row) ?? [];
			ranges.push({ start: match.start, end: match.end, style });
			rows.set(match.row, ranges);
		}

		if (rows.size === 0) return lines;
		const result = lines.slice();

		for (const [row, ranges] of rows) {
			const line = result[row];

			if (line !== undefined) result[row] = highlightLine(line, ranges);
		}

		return result;
	}

	private decorate(owner: Owner, rendered: string[]): string[] {
		const layout = this.layout();
		const lines = this.highlight(owner, rendered);

		return (this.flash ?? this.target(layout).paint)(layout, owner, lines);
	}

	private paintBlocks(
		layout: Layout,
		owner: Owner,
		lines: string[],
		from: number,
		to: number,
		inner: boolean,
	): string[] {
		let span: Rows | undefined;
		let cursor: Rows | undefined;

		for (let i = from; i <= to; i++) {
			if (this.block(i).owner !== owner) continue;
			const rows = blockRows(this.blocks, layout, i, inner);

			if (!rows) continue;

			if (i === this.cursor) cursor = rows;
			span = span ? [Math.min(span[0], rows[0]), Math.max(span[1], rows[1])] : rows;
		}

		if (!span) return lines;

		// Blocks in a range are contiguous, so every row between the first and the last one is selected.
		const [open, close] = this.background;
		const result = lines.slice();

		for (let row = span[0]; row <= span[1] && row < result.length; row++) {
			const line = result[row] ?? "";
			const marker = cursor && row >= cursor[0] && row <= cursor[1] ? "accent" : "borderMuted";

			// Image rows get spaces, so the background shows at the side of the image. The Kitty row keeps the cursor at
			// the start, and the image covers the spaces under it.
			// oxlint-disable-next-line no-control-regex -- the row of a Kitty image starts with its APC sequence.
			if (isTool(owner) && (line === "" || /^\x1b_G[^\x1b]*C=1/.test(line))) {
				result[row] = line + open + " ".repeat(layout.width) + close;
				continue;
			}

			const barred = line.replace(BAR_SLOT, (_, prefix: string) => prefix + this.theme.fg(marker, "▌"));
			result[row] = open + barred.replace(RESET, (reset) => reset + open) + close;
		}

		return result;
	}

	/** The row of the owner in the transcript comes from base renders each time, because the transcript grows. */
	private reveal(layout: Layout): void {
		const view = this.scrollView;
		const target = this.target(layout);

		if (!view || !target.rows) return;
		const owner = offsetOf(view.child, target.owner, layout.width);

		if (owner === undefined) return;
		const margin = 2;
		const top = owner + target.rows[0] - margin;
		const bottom = owner + target.rows[1] + margin;

		if (target.focus !== undefined && bottom - top + 1 > view.viewportHeight) {
			// The block is taller than the view, so the view goes to the focus row and puts it in the middle.
			const row = owner + target.focus;

			if (row - margin < view.scrollTop || row + margin >= view.scrollTop + view.viewportHeight) {
				view.scrollTo(Math.max(0, row - Math.floor(view.viewportHeight / 2)), { disableFollow: true });
			}

			return;
		}

		if (top < view.scrollTop || bottom - top + 1 > view.viewportHeight) {
			view.scrollTo(top, { disableFollow: true });
		} else if (bottom >= view.scrollTop + view.viewportHeight) {
			view.scrollTo(bottom - view.viewportHeight + 1, { disableFollow: true });
		}
	}
}
