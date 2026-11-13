/**
 * The visible text of rendered terminal lines for `/vc`: the parse of their escape sequences, the search in their text
 * and the styles that it puts on ranges of their characters.
 */
import { stripTerminalSequences } from "@earendil-works/pi-tui";

// One terminal sequence: CSI, OSC, APC or a two-byte escape.
// oxlint-disable-next-line no-control-regex -- the sequences start with ESC.
const ESCAPE = /\x1b(?:\[[0-9;:?<=>]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x1b]*\x1b\\|[@-Z\\-_])/y;

/** The columns from `start` to `end`, the end excluded, in the visible text of a line. */
export type Range = { start: number; end: number };

/** The sequences that open and close a style. */
export type Style = [string, string];

/** Whether the line shows no text. */
export function isBlank(line: string): boolean {
	return stripTerminalSequences(line).trim() === "";
}

/** A piece of a rendered line: a terminal sequence, or a visible character (one or two code units) at index `at`. */
type Piece = { escape: string } | { char: string; at: number };

/** Gives the terminal sequences and the visible characters of a line, in order. */
function* scan(line: string): Generator<Piece> {
	let i = 0;

	while (i < line.length) {
		ESCAPE.lastIndex = i;
		const escape = ESCAPE.exec(line)?.[0];

		if (escape !== undefined) {
			yield { escape };
			i += escape.length;
			continue;
		}

		const char = String.fromCodePoint(line.codePointAt(i) ?? 0);
		yield { char, at: i };
		i += char.length;
	}
}

/** The visible text of a rendered line, and the position in the line of each code unit of it. */
export type PlainText = { text: string; index: number[] };

/** Gives the visible text of a rendered line, and the position in the line of each code unit of it. */
export function plainText(line: string): PlainText {
	let text = "";
	const index: number[] = [];

	for (const piece of scan(line)) {
		if ("escape" in piece) continue;

		for (let unit = 0; unit < piece.char.length; unit++) index.push(piece.at + unit);
		text += piece.char;
	}

	return { text, index };
}

/**
 * Gives the start of each match of the query in the text. The query ignores case unless it has an uppercase letter, as
 * Vim does with smartcase.
 */
export function occurrences(text: string, query: string): number[] {
	const fold = query === query.toLowerCase();
	const haystack = fold ? text.toLowerCase() : text;
	const found: number[] = [];

	for (let at = haystack.indexOf(query); at !== -1; at = haystack.indexOf(query, at + query.length)) found.push(at);

	return found;
}

/**
 * Puts each visible character of the ranges between the open and close sequences of its range. Each character gets its
 * own sequences, so the colors of the line cannot cancel them.
 */
export function highlightLine(line: string, ranges: Array<Range & { style: Style }>): string {
	const { index } = plainText(line);
	const styles = new Map<number, Style>();

	for (const { start, end, style } of ranges) {
		for (const at of index.slice(start, end)) styles.set(at, style);
	}

	let out = "";

	for (const piece of scan(line)) {
		if ("escape" in piece) {
			out += piece.escape;
			continue;
		}

		const style = styles.get(piece.at);
		out += style ? style[0] + piece.char + style[1] : piece.char;
	}

	return out;
}

/** Whether inverse video is on after the SGR sequence `escape`, when it was `on` before. */
function inverseAfter(escape: string, on: boolean): boolean {
	// oxlint-disable-next-line no-control-regex -- an SGR sequence starts with ESC.
	const sgr = /^\x1b\[([\d;]*)m$/.exec(escape);

	if (!sgr) return on;
	const params = (sgr[1] ?? "").split(";");
	let next = on;

	for (let p = 0; p < params.length; p++) {
		const code = Number(params[p] || 0);

		// Extended colors take their own parameters, which can contain 7 or 27.
		if (code === 38 || code === 48) p += params[p + 1] === "5" ? 2 : 4;
		else if (code === 7) next = true;
		else if (code === 0 || code === 27) next = false;
	}

	return next;
}

/**
 * Gives the runs of visible text where inverse video (SGR 7) is on, without their trailing spaces. The line starts with
 * inverse off, as each terminal row does after the reset at its end.
 */
export function inverseRuns(line: string): Range[] {
	const runs: Range[] = [];
	let on = false;
	let col = 0;
	let start = 0;
	let text = "";

	const close = () => {
		let end = col;

		while (end > start && text[end - 1] === " ") end--;

		if (end > start) runs.push({ start, end });
	};

	for (const piece of scan(line)) {
		if ("escape" in piece) {
			const next = inverseAfter(piece.escape, on);

			if (next && !on) start = col;

			if (!next && on) close();
			on = next;
			continue;
		}

		text += piece.char;
		col += piece.char.length;
	}

	if (on) close();

	return runs;
}
