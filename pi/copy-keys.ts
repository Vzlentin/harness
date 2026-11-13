/** The keys of `/vc`, its status line, and the move between the code spans of two rows. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Span } from "./transcript.ts";

/** What a key does in `/vc`. */
export type Action =
	| "down"
	| "up"
	| "left"
	| "right"
	| "top"
	| "bottom"
	| "copy"
	| "copyAlt"
	| "back"
	| "quit"
	| "nextMessage"
	| "prevMessage"
	| "search"
	| "searchBack"
	| "next"
	| "prev"
	| "range"
	| "messageRange"
	| "code";

/** A key and what it does, for the status line. */
export type Hint = [string, string];

/** Gives what the key `data` does, or undefined when it does nothing. */
export function action(data: string): Action | undefined {
	const key = decodeKittyPrintable(data) ?? data;
	const one = (keys: string) => key.length === 1 && keys.includes(key);

	if (matchesKey(data, "escape")) return "back";

	if (key === "q") return "quit";

	if (key === "y" || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) return "copy";

	if (key === "Y") return "copyAlt";

	if (key === "j" || matchesKey(data, "down")) return "down";

	if (key === "k" || matchesKey(data, "up")) return "up";

	if (key === "h" || matchesKey(data, "left")) return "left";

	if (key === "l" || matchesKey(data, "right")) return "right";

	if (one("}]J") || matchesKey(data, "shift+down")) return "nextMessage";

	if (one("{[K") || matchesKey(data, "shift+up")) return "prevMessage";

	if (key === "g" || matchesKey(data, "home")) return "top";

	if (key === "G" || matchesKey(data, "end")) return "bottom";

	if (key === "/") return "search";

	if (key === "?") return "searchBack";

	if (key === "n") return "next";

	if (key === "N") return "prev";

	if (key === "v") return "range";

	if (key === "V") return "messageRange";

	if (key === "w") return "code";

	return undefined;
}

/** Gives the three rows of the status line: a border, `left` with the hints at the right, and a border. */
export function statusLine(theme: Theme, width: number, left: string, hints: Hint[]): string[] {
	const border = theme.fg("borderAccent", "\u2500".repeat(width));

	const right = hints
		.map(([key, label]) => theme.fg("accent", key) + theme.fg("dim", ` ${label}`))
		.join(theme.fg("dim", " \u00b7 "));

	const gap = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right) - 1));

	return [border, truncateToWidth(left + gap + right, width), border];
}

/** Gives the span on the next or previous row that is nearest to the column of the span at `index`. */
export function rowNeighbor(spans: Span[], index: number, step: 1 | -1): number | undefined {
	const span = spans[index];

	if (!span) return undefined;
	const sameRow = (i: number, other: Span) => spans[i]?.owner === other.owner && spans[i]?.start[0] === other.start[0];
	let i = index;

	while (sameRow(i, span)) i += step;
	const row = spans[i];

	if (!row) return undefined;
	const distance = (k: number) => Math.abs((spans[k]?.start[1] ?? 0) - span.start[1]);
	let best = i;

	for (let k = i; sameRow(k, row); k += step) {
		if (distance(k) < distance(best)) best = k;
	}

	return best;
}
