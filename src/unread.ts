/**
 * The unread answers of a child, from the marks of its record: which requests a `wait` or a push gives the answers of,
 * their text, and whether a child holds its caller. The `Children` commits that set the marks are in `targets.ts`.
 */

import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Answer, Child } from "./children.ts";
import type { ChildRecord, ChildrenState } from "./targets.ts";

/** The `detail` of a failed turn that is an error object. */
const ErrorDetail = Type.Object({ message: Type.String() });

/** Whether `record` has a request with `notify` whose answer no `wait` and no push gave. */
export function unreadNotify(record: Readonly<ChildRecord>): boolean {
	const quiet = record.quiet ?? [];

	return (record.sent ?? []).slice(record.read ?? 0).some((requestId) => !quiet.includes(requestId));
}

/**
 * Whether a child of `conversationId` holds it: the child has an answer to push that the conversation did not get yet.
 * A held conversation counts as busy.
 */
export function isHeld(state: Readonly<ChildrenState> | null | undefined, conversationId: ConversationId): boolean {
	const caller = String(conversationId);

	return Object.values(state?.children ?? {}).some((record) => record.caller === caller && unreadNotify(record));
}

/**
 * The text of the unread answers, and the new `read` of the record. `failed` is true when the last answer is a
 * failure; the text is then the error of the wait.
 */
export type UnreadAnswers = { readonly text: string; readonly failed: boolean; readonly read: number };

/**
 * The unread answers of `record` that a wait for `main` gives, oldest first. `answer` is the answer to `main`, and
 * `atStart` the requests of `sent` when the wait started.
 */
export async function unreadAnswers(
	child: Child,
	handle: string,
	record: Readonly<ChildRecord>,
	main: string | null,
	answer: Answer,
	atStart: readonly string[],
	waiting: Context,
): Promise<UnreadAnswers> {
	const unread = unreadBefore(record.sent ?? [], record.read ?? 0, main, atStart);
	const earlier: Answer[] = [];

	for (const requestId of unread.ids) {
		const before = await child.settled(waiting, requestId);

		// A steer goes into the turn that was running, so its request can share that turn's answer.
		if (!("entry" in before && "entry" in answer && before.entry === answer.entry)) earlier.push(before);
	}

	const texts = earlier.map((before) => {
		const text = answerText(handle, before);

		return text.failed ? `(no answer: ${text.text})` : text.text;
	});

	const last = answerText(handle, answer);
	const all = [...texts, last.text];
	const parts = all.map((text, index) => `--- Answer ${index + 1} of ${all.length} ---\n${text}`);

	const text = texts.length === 0 ? last.text : `${all.length} unread answers, oldest first.\n\n${parts.join("\n\n")}`;

	return { text, failed: last.failed, read: unread.read };
}

/** The requests whose answers a wait gives before its own, and the new `read` of the child record. */
type Unread = { readonly ids: readonly string[]; readonly read: number };

/**
 * The requests of `sent` from `read` on that a wait for `main` gives before the answer to `main`, and the new `read`.
 * When `main` is a request of the caller, they are the ones before it, and `main` counts as read; a send after it
 * stays unread. Otherwise, such as for the input of a mirror session, they are the caller's requests known when the wait started.
 */
function unreadBefore(sent: readonly string[], read: number, main: string | null, atStart: readonly string[]): Unread {
	const index = main === null ? -1 : sent.indexOf(main);

	if (index >= read) return { ids: sent.slice(read, index), read: index + 1 };

	if (index >= 0) return { ids: [], read };

	return { ids: atStart.slice(read), read: Math.max(read, atStart.length) };
}

/** The text of `answer`, or the failure of a turn with no answer. A cut answer still gives its text. */
function answerText(handle: string, answer: Answer) {
	if (answer.status === "ok" || answer.reason !== "unanswered") return { text: answer.text, failed: false };

	if (answer.cause === "queued") {
		return { text: `${handle} stopped with queued messages after a failed turn`, failed: true };
	}

	return { text: failureText(handle, answer.cause, answer.detail), failed: true };
}

function failureText(handle: string, reason: string, detail: JsonValue | undefined): string {
	if (reason === "aborted") return `${handle} was aborted`;

	const text = Value.Check(Type.String(), detail)
		? detail
		: Value.Check(ErrorDetail, detail)
			? detail.message
			: undefined;

	return text === undefined ? `${handle} failed: ${reason}` : `${handle} failed: ${text}`;
}
