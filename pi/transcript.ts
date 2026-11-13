/**
 * The layout of the transcript for `/vc`: its blocks, their rows at a width, their inline code spans and the matches of
 * a search. Pi has no public API for the transcript, so `/vc` reads the live component tree of Pi's TUI.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Marked, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Diagram } from "./clipboard.ts";
import { inverseRuns, isBlank, occurrences, plainText, type Range } from "./terminal-text.ts";

// The internal members of Pi's components that /vc reads.

export interface Node extends Component {
	children?: Node[];
}

/** The theme of a Markdown node: /vc wraps its style of inline code. */
type MarkdownTheme = { code(text: string): string };

/** The arguments of the Markdown render methods that /vc passes on without reading them. */
type PassedOn = never[];

export interface MarkdownNode extends Node {
	text: string;
	paddingX: number;
	theme: MarkdownTheme;
	options?: { transform?: (text: string, width: number) => string };
	cachedTokens?: WeakRef<{ tokens: Token[] }>;
	renderToken(token: Token, ...rest: PassedOn): string[];
	renderInlineTokens(tokens: Token[], ...rest: PassedOn): string;
}

export interface AssistantNode extends Node {
	contentContainer: Node;
	updateContent(): void;
}

export interface ImageNode extends Node {
	base64Data: string;
	mimeType: string;
}

export interface ToolNode extends Node {
	toolName: string;
	args?: { path?: string; file_path?: string };
	cwd?: string;
	imageComponents: ImageNode[];
}

/** A component that has selectable blocks: an assistant message, or a tool with images. */
export type Owner = AssistantNode | ToolNode;

export interface ScrollViewNode {
	child: Node;
	scrollTop: number;
	viewportHeight: number;
	isFollowingEnd: boolean;
	getContentWidth(width: number): number;
	scrollTo(top: number, options?: { disableFollow?: boolean }): void;
	scrollToEnd(): void;
}

/** A Markdown token, as Marked gives it. */
interface Token {
	type: string;
	lang?: string;
	raw: string;
	text?: string;
	tokens?: Token[];
	items?: Array<{ raw: string; tokens: Token[] }>;
}

/** The first and the last row, both included. */
export type Rows = [number, number];

/** A row and a column. */
export type Position = [number, number];

/**
 * A selectable part of the transcript. A text block is a top-level element, a list item or a code block of one Markdown
 * node. `container` is the index of the block around it, such as the list item around a code block.
 */
export interface TextBlock {
	kind: "text";
	owner: AssistantNode;
	markdown: MarkdownNode;
	segment: number;
	message: number;
	container?: number | undefined;
	raw: string;
	code?: string | undefined;
	quote?: string | undefined;
	diagram?: Diagram | undefined;
}

/** An image that a tool result shows, with the file path when the tool read one. */
export interface ImageBlock {
	kind: "image";
	owner: ToolNode;
	image: ImageNode;
	path?: string | undefined;
	message: number;
}

export type Block = TextBlock | ImageBlock;

/** A part of one Markdown node, with its rows in the node. */
interface Segment {
	rows: Rows;
	raw: string;
	code?: string | undefined;
	quote?: string | undefined;
	parent?: number | undefined;
	diagram?: Diagram | undefined;
}

/**
 * An inline code span in a rendered Markdown node. Positions are [row, column] in the visible text of the rows, and the
 * end column is exclusive. `id` is the order in which the render styles the span, and `segment` is the innermost
 * segment that has it.
 */
interface SpanPosition {
	id: number;
	segment: number;
	start: Position;
	end: Position;
	text: string;
	raw: string;
}

/** An inline code span with its rows in the owner. */
export interface Span extends SpanPosition {
	block: number;
	owner: AssistantNode;
	markdown: MarkdownNode;
}

/**
 * The geometry of the blocks at one width. Rows are rows in the owner. `offsets` gives the row of each Markdown node in
 * its owner. `owners` gives the rendered rows of each assistant message and its blocks, for search.
 */
export interface Layout {
	width: number;
	rows: Array<Rows | undefined>;
	offsets: Map<MarkdownNode, number>;
	owners: Array<{ owner: AssistantNode; lines: string[]; blocks: number[] }>;
	spans: Span[];
}

/**
 * One match of the search query: a row of a rendered assistant message, and the columns in its visible text. `block` is
 * the innermost block that has the row.
 */
export interface Match {
	block: number;
	owner: Owner;
	row: number;
	start: number;
	end: number;
}

// Marks around blocks (b) and inline code spans (c), with their start (s) and end (e).
// OSC sequences have no width, so they do not change wrapping or table columns.
// oxlint-disable-next-line no-control-regex -- the marks are OSC sequences, which start with ESC.
const MARK = /\x1b\]vc;([bc])(\d+);([se])\x07/g;

function mark(kind: "b" | "c", id: number, edge: "s" | "e"): string {
	return `\x1b]vc;${kind}${id};${edge}\x07`;
}

const Text = Type.String();

function isString(value: unknown): value is string {
	return Value.Check(Text, value);
}

function isMarkdown(node: Node): node is MarkdownNode {
	return "renderToken" in node && node.renderToken instanceof Function && "text" in node && isString(node.text);
}

function isAssistant(node: Node): node is AssistantNode {
	return (
		"updateContent" in node &&
		node.updateContent instanceof Function &&
		"contentContainer" in node &&
		isNode(node.contentContainer) &&
		Array.isArray(node.contentContainer.children)
	);
}

function isNode(value: unknown): value is Node {
	return value instanceof Object && "render" in value && value.render instanceof Function;
}

export function isTool(node: Node): node is ToolNode {
	return (
		"toolName" in node && isString(node.toolName) && "imageComponents" in node && Array.isArray(node.imageComponents)
	);
}

function isOwner(node: Node): node is Owner {
	return isAssistant(node) || isTool(node);
}

function findOwners(root: Node, found: Owner[] = []): Owner[] {
	if (isOwner(root)) found.push(root);
	else for (const child of root.children ?? []) findOwners(child, found);

	return found;
}

/** Gives the absolute path of the file that a tool such as read opened, if there is one. */
function toolPath(tool: ToolNode): string | undefined {
	const value = tool.args?.path ?? tool.args?.file_path;

	if (!isString(value) || !value.trim()) return undefined;

	const path = value
		.trim()
		.replace(/^@/, "")
		.replace(/^~(?=\/|$)/, homedir());

	return resolve(tool.cwd ?? process.cwd(), path);
}

export function textParts(owner: AssistantNode): MarkdownNode[] {
	return (owner.contentContainer.children ?? []).filter(isMarkdown);
}

/** The scroll view of the transcript, when the TUI has one. */
export function scrollViewOf(tui: TUI): ScrollViewNode | undefined {
	if (!("getPrimaryScrollView" in tui) || !(tui.getPrimaryScrollView instanceof Function)) return undefined;

	// SAFETY: the full-screen TUI of Pi gives the scroll view of its transcript, with these members.
	return (tui.getPrimaryScrollView as () => ScrollViewNode | undefined).call(tui);
}

/** The width that the transcript gets when it renders. */
export function contentWidth(tui: TUI): number {
	return scrollViewOf(tui)?.getContentWidth(tui.terminal.columns) ?? tui.terminal.columns;
}

/** /vc puts its own render on each owner, so the rows of an owner come from the class render. */
export function baseRender(owner: Owner, width: number): string[] {
	// SAFETY: an owner is an instance of a Pi component class, whose prototype has its render.
	const prototype = Object.getPrototypeOf(owner) as Node;

	return prototype.render.call(owner, width);
}

/**
 * Gives the row of `target` inside the rendered output of `root`. Owners give their base rows, so the count does not
 * decorate them.
 */
export function offsetOf(root: Node, target: Node, width: number): number | undefined {
	if (root === target) return 0;
	let row = 0;

	for (const child of root.children ?? []) {
		const inner = offsetOf(child, target, width);

		if (inner !== undefined) return row + inner;
		row += (isOwner(child) ? baseRender(child, width) : child.render(width)).length;
	}

	return undefined;
}

/** Gives the first row and the row count of each owner in the rendered output of `root`. */
export function ownerRows(
	root: Node,
	width: number,
	start = 0,
	found = new Map<Owner, [number, number]>(),
): Map<Owner, [number, number]> {
	let row = start;

	for (const child of root.children ?? []) {
		if (isOwner(child)) {
			const height = baseRender(child, width).length;
			found.set(child, [row, height]);
			row += height;
		} else {
			ownerRows(child, width, row, found);
			row += child.render(width).length;
		}
	}

	return found;
}

/** Renders the Markdown with the patch on the node, then restores the node and clears its cache. */
function probe(markdown: MarkdownNode, patch: Partial<MarkdownNode>, width: number): string[] {
	const saved = Object.keys(patch).map((key) => [key, Object.getOwnPropertyDescriptor(markdown, key)] as const);
	Object.assign(markdown, patch);

	try {
		markdown.invalidate();

		return markdown.render(width);
	} finally {
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(markdown, key, descriptor);
			else Reflect.deleteProperty(markdown, key);
		}

		markdown.invalidate();
	}
}

/** A patch of a Markdown node, and the inline code span tokens that its render met, in the order of their IDs. */
type CodePatch = { patch: Partial<MarkdownNode>; tokens: Token[] };

/**
 * Gives a patch that passes each inline code span through `wrap`, with the order in which the render styles it. Each
 * call of renderInlineTokens puts its code span tokens on a stack, and theme.code takes the next one, so a table that
 * renders a cell more than one time gives the same id each time.
 */
function codePatch(markdown: MarkdownNode, wrap: (id: number, styled: string) => string): CodePatch {
	const ids = new Map<Token, number>();
	const tokens: Token[] = [];
	const pending: Token[][] = [];
	const theme = markdown.theme;
	const renderInline = markdown.renderInlineTokens.bind(markdown);

	const code = (text: string): string => {
		const styled = theme.code(text);
		const token = pending.at(-1)?.shift();

		if (!token) return styled;
		let id = ids.get(token);

		if (id === undefined) {
			id = tokens.length;
			ids.set(token, id);
			tokens.push(token);
		}

		return wrap(id, styled);
	};

	// SAFETY: Object.create gives an object with the theme as its prototype, so it has every member of the theme.
	const wrapped = Object.create(theme) as MarkdownTheme;

	const patch: Partial<MarkdownNode> = {
		theme: Object.assign(wrapped, { code }),
		renderInlineTokens(list: Token[], ...rest: PassedOn) {
			pending.push(list.filter((token) => token.type === "codespan"));

			try {
				return renderInline(list, ...rest);
			} finally {
				pending.pop();
			}
		},
	};

	return { patch, tokens };
}

/** Gives the index of the smallest row range that has the row. The first one wins a tie. */
export function innermost(ranges: Array<Rows | undefined>, row: number): number | undefined {
	let found: number | undefined;
	let best: Rows | undefined;

	ranges.forEach((rows, i) => {
		if (!rows || row < rows[0] || row > rows[1]) return;

		if (!best || rows[1] - rows[0] < best[1] - best[0]) {
			found = i;
			best = rows;
		}
	});

	return found;
}

/** Gives the rows of a token list. Lists inside list items do not go through renderToken, so their rows come from their items. */
function spanOf(tokens: Token[], rows: Map<Token, Rows>): Rows | undefined {
	let span: Rows | undefined;

	for (const token of tokens) {
		const r =
			rows.get(token) ??
			(token.items &&
				spanOf(
					token.items.flatMap((i) => i.tokens),
					rows,
				));

		if (r) span = span ? [Math.min(span[0], r[0]), Math.max(span[1], r[1])] : r;
	}

	return span;
}

function isMermaid(token: Token): boolean {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function dedent(text: string): string {
	const lines = text.split("\n");
	const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));

	return lines.map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length))).join("\n");
}

/** The tokens of the Markdown text. */
function lex(text: string): Token[] {
	// SAFETY: Marked's tokens have these members, with `items` on lists and `tokens` on the tokens with children.
	return new Marked().lexer(text) as Token[];
}

/**
 * Pi replaces each Mermaid code block with one inline code span for each diagram row. This gives the source tokens, by
 * the rendered Markdown that replaces them.
 */
function diagramSources(markdown: MarkdownNode, width: number): Map<string, Token> {
	const sources = new Map<string, Token>();
	const transform = markdown.options?.transform;

	if (!transform || !/^\s*(```|~~~)\s*mermaid/im.test(markdown.text)) return sources;
	const textWidth = Math.max(1, width - markdown.paddingX * 2);

	for (const token of lex(markdown.text)) {
		if (!isMermaid(token)) continue;
		const rendered = transform(token.raw, textWidth);

		if (rendered !== token.raw) sources.set(rendered.trim(), token);
	}

	return sources;
}

function leadingSpaces(text: string): number {
	return text.length - text.trimStart().length;
}

/** The rows from the first line that shows text to the last one, or undefined when no line shows text. */
function textRows(lines: string[]): Rows | undefined {
	const first = lines.findIndex((l) => !isBlank(l));

	if (first === -1) return undefined;

	return [first, lines.findLastIndex((l) => !isBlank(l))];
}

/** The layout of one Markdown node: its segments and its inline code spans. */
type MarkdownLayout = { segments: Segment[]; spans: SpanPosition[] };

/**
 * Renders the Markdown one time with marks around each block token and each inline code span, and gives the segments
 * and the code spans. Diagram rows are not code spans.
 */
function markdownLayout(markdown: MarkdownNode, width: number): MarkdownLayout {
	const ids = new Map<Token, number>();
	const renderToken = markdown.renderToken.bind(markdown);
	const code = codePatch(markdown, (id, styled) => mark("c", id, "s") + styled + mark("c", id, "e"));

	const patch: Partial<MarkdownNode> = {
		...code.patch,
		renderToken(token: Token, ...rest: PassedOn) {
			const rendered = renderToken(token, ...rest);
			const rows = textRows(rendered);

			if (!rows) return rendered;
			const id = ids.get(token) ?? ids.size;
			ids.set(token, id);
			const marked = rendered.slice();
			marked[rows[0]] = mark("b", id, "s") + (marked[rows[0]] ?? "");
			marked[rows[1]] = (marked[rows[1]] ?? "") + mark("b", id, "e");

			return marked;
		},
	};

	const lines = probe(markdown, patch, width);
	const tokens = markdown.cachedTokens?.deref()?.tokens ?? [];
	const blockStarts = new Map<number, number>();
	const blockRows = new Map<number, Rows>();
	const codeStarts = new Map<number, Position>();
	const codeEnds = new Map<number, Position>();

	lines.forEach((line, row) => {
		for (const found of line.matchAll(MARK)) {
			const [, kind, idText, edge] = found;
			const id = Number(idText);

			if (kind === "c") {
				const at: Position = [row, plainText(line.slice(0, found.index)).text.length];
				(edge === "s" ? codeStarts : codeEnds).set(id, at);
			} else if (edge === "s") {
				blockStarts.set(id, row);
			} else {
				blockRows.set(id, [blockStarts.get(id) ?? row, row]);
			}
		}
	});

	const rows = new Map<Token, Rows>();

	for (const [token, id] of ids) {
		const r = blockRows.get(id);

		if (r) rows.set(token, r);
	}

	const diagrams = diagramSources(markdown, width);
	const segments: Segment[] = [];

	const add = (span: Rows | undefined, raw: string, segmentCode?: string, parent?: number): Segment | undefined => {
		if (!span) return undefined;
		const segment: Segment = { rows: span, raw: raw.trim(), code: segmentCode, parent };
		segments.push(segment);

		return segment;
	};

	const walk = (list: Token[], top: boolean, parent?: number) => {
		for (const token of list) {
			const source = top ? diagrams.get(token.raw.trim()) : undefined;
			const tokenRows = rows.get(token);

			if (token.items) {
				for (const item of token.items) {
					add(spanOf(item.tokens, rows), item.raw, undefined, parent);
					walk(item.tokens, false, segments.length - 1);
				}
			} else if (source) {
				if (tokenRows) {
					const diagram = { source: dedent(source.text ?? "") };
					segments.push({ rows: tokenRows, raw: source.raw.trim(), parent, diagram });
				}
			} else if (top || token.type === "code") {
				const blockCode = token.type === "code" ? dedent(token.text ?? "") : undefined;
				const segment = add(tokenRows, token.raw, blockCode, parent);

				if (segment && isMermaid(token) && blockCode !== undefined) segment.diagram = { source: blockCode };

				// Marked removes one level of quote markers from the text of a blockquote.
				if (segment && token.type === "blockquote") segment.quote = token.text?.trim();

				if (token.tokens) walk(token.tokens, false, segments.length - 1);
			} else if (token.tokens) {
				walk(token.tokens, false, parent);
			}
		}
	};

	walk(tokens, true);

	if (segments.length === 0) add(textRows(lines), markdown.text);

	return { segments, spans: spanPositions(lines, segments, code.tokens, codeStarts, codeEnds) };
}

/** The inline code spans of the rendered lines, from the marks of their starts and ends, in the order of their rows. */
function spanPositions(
	lines: string[],
	segments: Segment[],
	tokens: Token[],
	starts: Map<number, Position>,
	ends: Map<number, Position>,
): SpanPosition[] {
	const plain = lines.map((line) => plainText(line).text);
	const rowText = (row: number) => plain[row] ?? "";
	const segmentRows = segments.map((s) => s.rows);
	const spans: SpanPosition[] = [];

	tokens.forEach((token, id) => {
		let start = starts.get(id);
		let end = ends.get(id);

		if (!start || !end) return;

		// A wrap can put a mark at the end of the row before the span or at the start of the row after it.
		if (start[1] >= rowText(start[0]).trimEnd().length && start[0] + 1 < plain.length) {
			start = [start[0] + 1, leadingSpaces(rowText(start[0] + 1))];
		}

		if (end[0] > start[0] && end[1] <= leadingSpaces(rowText(end[0]))) {
			end = [end[0] - 1, rowText(end[0] - 1).trimEnd().length];
		}

		const segment = innermost(segmentRows, start[0]);

		if (segment === undefined || segments[segment]?.diagram) return;
		spans.push({ id, segment, start, end, text: token.text ?? "", raw: token.raw });
	});

	spans.sort((a, b) => a.start[0] - b.start[0] || a.start[1] - b.start[1]);

	return spans;
}

/** The blocks of the assistant messages and of the tool images under `document`, in the order of the transcript. */
export function collectBlocks(document: Node, width: number): Block[] {
	const blocks: Block[] = [];
	let message = 0;

	for (const owner of findOwners(document)) {
		const before = blocks.length;

		if (isTool(owner)) {
			const path = toolPath(owner);

			for (const image of owner.imageComponents) blocks.push({ kind: "image", owner, image, path, message });
		} else {
			for (const markdown of textParts(owner)) {
				const first = blocks.length;

				markdownLayout(markdown, width).segments.forEach(({ raw, code, quote, diagram, parent }, segment) => {
					const container = parent === undefined ? undefined : first + parent;
					blocks.push({ kind: "text", owner, markdown, segment, message, container, raw, code, quote, diagram });
				});
			}
		}

		if (blocks.length > before) message++;
	}

	return blocks;
}

/**
 * Pi replaces the Markdown nodes of a message while it streams. The blocks of a replaced node drop out of the layout,
 * and y still copies the text that they had when /vc opened.
 */
export function isGone(block: Block): boolean {
	return block.kind === "text" && !textParts(block.owner).includes(block.markdown);
}

/**
 * Image rows are blank except for the one row with the terminal image sequence, so this finds that row in the output of
 * the tool.
 */
function imageRows(owner: ToolNode, image: ImageNode, width: number): Rows | undefined {
	const lines = baseRender(owner, width);
	const imageLines = image.render(width);
	const index = imageLines.findIndex((l) => l !== "");
	const shown = imageLines[index];
	const row = shown === undefined ? -1 : lines.indexOf(shown);

	if (row === -1) return undefined;

	return [row - index, row - index + imageLines.length - 1];
}

/** The layout of one Markdown node, its row in its owner, and the block of each of its segments. */
type Parsed = { layout: MarkdownLayout; owner: AssistantNode; offset: number; blocks: Map<number, number> };

export function buildLayout(blocks: Block[], width: number): Layout {
	const rows: Array<Rows | undefined> = blocks.map(() => undefined);
	const parsed = new Map<MarkdownNode, Parsed>();
	const owners = new Map<AssistantNode, number[]>();

	blocks.forEach((block, i) => {
		if (block.kind === "image") {
			rows[i] = imageRows(block.owner, block.image, width);

			return;
		}

		if (isGone(block)) return;
		let entry = parsed.get(block.markdown);

		if (!entry) {
			const offset = offsetOf(block.owner, block.markdown, width);

			if (offset === undefined) return;
			entry = { layout: markdownLayout(block.markdown, width), owner: block.owner, offset, blocks: new Map() };
			parsed.set(block.markdown, entry);
		}

		const segment = entry.layout.segments[block.segment];

		if (!segment) return;
		rows[i] = [entry.offset + segment.rows[0], entry.offset + segment.rows[1]];
		entry.blocks.set(block.segment, i);
		const list = owners.get(block.owner) ?? [];
		list.push(i);
		owners.set(block.owner, list);
	});

	const spans: Span[] = [];
	const offsets = new Map<MarkdownNode, number>();

	for (const [markdown, { layout, owner, offset, blocks: bySegment }] of parsed) {
		offsets.set(markdown, offset);

		for (const span of layout.spans) {
			const block = bySegment.get(span.segment);

			if (block === undefined) continue;
			const start: Position = [offset + span.start[0], span.start[1]];
			const end: Position = [offset + span.end[0], span.end[1]];
			spans.push({ ...span, start, end, block, owner, markdown });
		}
	}

	return {
		width,
		rows,
		offsets,
		owners: [...owners].map(([owner, list]) => ({ owner, lines: baseRender(owner, width), blocks: list })),
		spans,
	};
}

/** Finds each match of the query in the rendered assistant messages, in document order. */
export function findMatches(layout: Layout, query: string): Match[] {
	const matches: Match[] = [];

	if (!query) return matches;

	for (const { owner, lines, blocks } of layout.owners) {
		const ranges = blocks.map((block) => layout.rows[block]);

		lines.forEach((line, row) => {
			const inner = innermost(ranges, row);
			const block = inner === undefined ? undefined : blocks[inner];

			if (block === undefined) return;

			for (const start of occurrences(plainText(line).text, query)) {
				matches.push({ block, owner, row, start, end: start + query.length });
			}
		});
	}

	return matches;
}

/**
 * Gives the next match, or the previous one when `backward` is set. With no current match, it starts after or before
 * the `origin` block. At the ends it wraps, as Vim does. With `byBlock`, it skips the other matches in the current
 * block and stops on the first match of the next block, so a range grows one block at a time.
 */
export function nextMatch(
	matches: Match[],
	current: number | undefined,
	origin: number,
	backward: boolean,
	byBlock: boolean,
): { index: number; wrapped: boolean } | undefined {
	const count = matches.length;

	if (count === 0) return undefined;
	const blockAt = (index: number) => matches[index]?.block;
	let next: number;
	const step = backward ? -1 : 1;

	if (current !== undefined) {
		next = current + step;
		const block = blockAt(current);

		while (byBlock && next >= 0 && next < count && blockAt(next) === block) next += step;
	} else if (backward) {
		next = matches.findLastIndex((m) => m.block < origin);
	} else {
		next = matches.findIndex((m) => m.block > origin);
	}

	const wrapped = next < 0 || next >= count;

	if (wrapped) next = backward ? count - 1 : 0;

	while (byBlock && next > 0 && blockAt(next - 1) === blockAt(next)) next--;

	return { index: next, wrapped };
}

/**
 * Gives the columns of the span on each of its rows. A render with the span in inverse video shows them:
 * wrapTextWithAnsi opens the style again on each wrapped row, after the blockquote border and the list indent, and a
 * table cell closes it before its padding.
 */
export function spanRanges(layout: Layout, span: Span): Array<Range & { row: number }> {
	const offset = layout.offsets.get(span.markdown);

	if (offset === undefined) return [];
	const code = codePatch(span.markdown, (id, styled) => (id === span.id ? `\x1b[7m${styled}\x1b[27m` : styled));
	const lines = probe(span.markdown, code.patch, layout.width);

	return lines.flatMap((line, i) => {
		const row = offset + i;

		if (row < span.start[0] || row > span.end[0]) return [];

		return inverseRuns(line).map((range) => ({ row, ...range }));
	});
}
