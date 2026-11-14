/**
 * The limits of the children that `rlm` spawns, the RLM children: how many are live, the size of their requests, the
 * time of a turn, the text of an answer, and the model requests of a tree at the same time.
 */

/** A size in bytes, and its text in the errors and in the docstring of `rlm`. */
type Size = { readonly bytes: number; readonly text: string };

/** `count` KiB. */
function kib(count: number): Size {
	return { bytes: count * 1024, text: `${count} KiB` };
}

/** `count` MiB. */
function mib(count: number): Size {
	return { bytes: count * 1024 * 1024, text: `${count} MiB` };
}

/** The RLM children of one caller that are not closed. */
export const MAX_LIVE_CHILDREN = 16;

/** The UTF-8 size of the prompt of an RLM spawn, with its files and context, and of the message of an RLM send. */
export const MAX_INPUT = mib(1);

/** The JSON around the input in a request line on a kernel socket. */
const LINE_MARGIN = kib(64);

/** The UTF-8 bytes of a request line on a kernel socket, before its newline: the input and the JSON around it. */
export const MAX_LINE_BYTES = MAX_INPUT.bytes + LINE_MARGIN.bytes;

/** The time of a turn of an RLM child, after which the host aborts it. */
export const TURN_DEADLINE_MS = 5 * 60_000;

/** The model requests of the RLM children of one tree at the same time. */
export const POOL_SIZE = 4;

export const TOO_MANY_LIVE = `${MAX_LIVE_CHILDREN} RLM children are live: stop one before you spawn another`;
export const SPAWN_TOO_LARGE = `The prompt of an RLM spawn, with its files and context, is more than ${MAX_INPUT.text}`;
export const SEND_TOO_LARGE = `The message of an RLM send is more than ${MAX_INPUT.text}`;
export const LINE_TOO_LONG = `Invalid rlm request: the line is longer than ${MAX_INPUT.text} plus ${LINE_MARGIN.text}`;

/** Whether `text` has more than `MAX_INPUT` in UTF-8. */
export function overInput(text: string): boolean {
	return Buffer.byteLength(text, "utf8") > MAX_INPUT.bytes;
}
