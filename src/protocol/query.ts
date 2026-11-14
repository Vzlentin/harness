/** The bound of the transcript that a `query` gives its model. */

/** The UTF-8 size of the transcript that a query reads: the last part of a longer conversation. */
export const MAX_QUERY = { bytes: 256 * 1024, text: "256 KiB" } as const;

/** The first line of the answer of a query that read only the last part of its conversation. */
export const QUERY_CUT_LINE = `[The conversation is longer than ${MAX_QUERY.text}: this answer reads only its last ${MAX_QUERY.text}]`;
