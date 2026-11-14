/** The cut of a long answer of a child, in `wait` and in a push. */

/** The UTF-8 size of an answer of a child that `wait` and a push give. */
export const MAX_ANSWER = { bytes: 256 * 1024, text: "256 KiB" } as const;

/** The last line of an answer that `cutAnswer` cut. */
export const CUT_LINE = `[The answer was cut at ${MAX_ANSWER.text}]`;

/** `CUT_LINE` on its own line, after the kept text. */
const CUT_NOTICE = `\n${CUT_LINE}`;

/**
 * `text`, or for a text of more than `MAX_ANSWER` in UTF-8, its longest start in that size that ends on a character
 * boundary, then the line `CUT_LINE`.
 */
export function cutAnswer(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_ANSWER.bytes) return text;
	// `encodeInto` writes only whole characters, and `read` counts the UTF-16 units of the characters that it wrote.
	const { read } = new TextEncoder().encodeInto(text, new Uint8Array(MAX_ANSWER.bytes));

	return `${text.slice(0, read)}${CUT_NOTICE}`;
}
