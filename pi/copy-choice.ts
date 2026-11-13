/** What `/vc` copies from a selection of blocks, and the rows of a block that the selection shows. */
import type { Diagram, ImageRef } from "./clipboard.ts";
import type { Hint } from "./copy-keys.ts";
import type { Block, Layout, Owner, Rows } from "./transcript.ts";

/** What `/vc` copies: a text, a diagram as an image, or an image or its path. */
export type CopyResult =
	| { kind: "text"; text: string }
	| { kind: "diagram"; diagram: Diagram }
	| { kind: "image"; image: ImageRef; path: boolean };

/** Gives the rows of an owner with the selection painted on them. */
export type Paint = (layout: Layout, owner: Owner, lines: string[]) => string[];

/** What y or Y copies. With `flash`, the view shows that paint for a moment before the copy. */
export interface Copy {
	result: CopyResult;
	flash?: Paint;
}

/**
 * What y and Y copy from the blocks `from` to `to`, and their hints. With `inner`, the selection is one code block, a
 * Mermaid block too, and shows only its code rows, without fences.
 */
export interface CopyChoice {
	copy: Copy;
	copyAlt: Copy;
	hints: Hint[];
	inner: boolean;
}

/** Gives what y and Y copy from the blocks `from` to `to`. Y on text flashes `raw`, the paint of the raw selection. */
export function selectionCopies(blocks: Block[], from: number, to: number, raw: Paint): CopyChoice {
	const first = blocks[from];

	if (!first) throw new Error(`/vc has no block ${from}`);
	const single = from === to;
	const inner = single && first.kind === "text" && first.code !== undefined;

	if (single && first.kind === "image") {
		const image = { data: first.image.base64Data, mimeType: first.image.mimeType, path: first.path };

		return {
			copy: { result: { kind: "image", image, path: false } },
			copyAlt: { result: { kind: "image", image, path: true } },
			hints: [
				["y", "copy image"],
				["Y", "copy path"],
			],
			inner,
		};
	}

	if (single && first.kind === "text" && first.diagram) {
		return {
			copy: { result: { kind: "diagram", diagram: first.diagram } },
			copyAlt: { result: { kind: "text", text: first.diagram.source } },
			hints: [
				["y", "copy image"],
				["Y", "copy source"],
			],
			inner,
		};
	}

	// Only one code block gives its code without fences, and only one blockquote gives its text without quote
	// markers. Y shows the raw selection for a moment before the copy.
	const text = single && first.kind === "text" ? (first.code ?? first.quote) : undefined;
	const selection = selectionText(blocks, from, to);

	return {
		copy: { result: { kind: "text", text: text ?? selection } },
		copyAlt: { result: { kind: "text", text: selection }, flash: raw },
		hints: [
			["y", "copy"],
			["Y", "copy raw"],
		],
		inner,
	};
}

/** The raw text of the blocks `from` to `to`. A nested block is already in the raw text of its selected container. */
export function selectionText(blocks: Block[], from: number, to: number): string {
	return blocks
		.slice(from, to + 1)
		.flatMap((b) => {
			if (b.kind === "image") return [b.path ?? `[image ${b.image.mimeType}]`];

			return b.container === undefined || b.container < from ? [b.raw] : [];
		})
		.join("\n\n");
}

/**
 * Gives the rows of the block at `index` in its owner. With `inner`, a code block gives only its code rows, without
 * the two fence rows.
 */
export function blockRows(blocks: Block[], layout: Layout, index: number, inner: boolean): Rows | undefined {
	const rows = layout.rows[index];
	const block = blocks[index];

	if (!rows || !block) return undefined;
	const trim = inner && block.kind === "text" && block.code !== undefined && rows[1] - rows[0] >= 2 ? 1 : 0;

	return [rows[0] + trim, rows[1] - trim];
}
