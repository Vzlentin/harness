/**
 * The `ChildRecords` of the host, one per child, with their read marks: which requests a `wait` or a push gives the
 * answers of, their text, and whether a child holds its caller.
 */
import { randomBytes } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Answer, Child } from "../children/library.ts";
import type { ChildKind } from "../protocol/requests.ts";

const context = BACKGROUND_CONTEXT;

export type ChildRecord = {
	name?: string;
	/** `PI_SESSION_ID` of the spawner: a Pi session, the conversation ID of another child, or `cli`. */
	caller: string;
	createdAt: string;
	conversationId: ConversationId;
	/** The spawn and each `send` of the caller, in order. */
	requests: ChildRequest[];
	/** How many of `requests` a `wait` or a push gave the answer of. */
	read: number;
	/** The request whose answer the last push gave as the last answer, so a `wait` for it gives no new answer. */
	pushed?: string;
	kind?: ChildKind;
};

/** A request of the caller. Without `notify`, its answer is not pushed and does not hold the caller. */
export type ChildRequest = { id: string; notify: boolean };

export type ChildrenState = { children: Record<string, ChildRecord>; requests: Record<string, string> };

/** The error of a store from before the children library, whose children the library does not know. */
export class OldChildRecordsError extends Error {}

/** A record of version 2: the request IDs in `sent`, and those without `notify` in `quiet`. */
const RecordV2 = Type.Object({
	name: Type.Optional(Type.String()),
	caller: Type.String(),
	createdAt: Type.String(),
	conversationId: Type.Unsafe<ConversationId>(Type.Integer()),
	sent: Type.Optional(Type.Array(Type.String())),
	read: Type.Optional(Type.Number()),
	pushed: Type.Optional(Type.String()),
	quiet: Type.Optional(Type.Array(Type.String())),
});

const ChildrenV2 = Type.Object({
	children: Type.Record(Type.String(), RecordV2),
	requests: Type.Record(Type.String(), Type.String()),
});

/**
 * The children by handle, and the handle of each spawn request ID. Version 3 keeps the requests of a child in one list;
 * version 2 kept their IDs in `sent` and those without `notify` in `quiet`. Version 2 leaves each child's last request
 * to the children library; a store with version 1 has children that the library does not know.
 */
export const ChildRecords = defineDoc<ChildrenState>({
	kind: "subagent.children",
	version: 3,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ children: {}, requests: {} }),
	migrate: (value, fromVersion) => {
		if (fromVersion < 2) throw new OldChildRecordsError(`subagent.children has version ${fromVersion}`);

		return migrateV2(Value.Parse(ChildrenV2, value));
	},
});

function migrateV2(state: Static<typeof ChildrenV2>): ChildrenState {
	const children = Object.fromEntries(
		Object.entries(state.children).map(([handle, { sent = [], quiet = [], read = 0, ...rest }]) => [
			handle,
			{ ...rest, requests: sent.map((id) => ({ id, notify: !quiet.includes(id) })), read },
		]),
	);

	return { children, requests: state.requests };
}

export async function childRecord(harness: Harness, handle: string): Promise<ChildRecord> {
	const state = await harness.snapshot(ChildRecords, context);
	const record = recordOf(state, handle);

	if (record === undefined) throw new Error(`Unknown subagent: ${handle}`);

	return record;
}

/** The record of `handle`, which must belong to `caller`. */
export async function ownRecord(harness: Harness, handle: string, caller: string): Promise<ChildRecord> {
	const record = await childRecord(harness, handle);

	if (record.caller !== caller) throw new Error(`Subagent ${handle} belongs to another session`);

	return record;
}

/** The handle of the child that the spawn request `requestId` opened, if any. */
export async function spawnedHandle(harness: Harness, requestId: string): Promise<string | undefined> {
	return (await harness.snapshot(ChildRecords, context))?.requests[requestId];
}

/** Adds the record of a new child under a free handle in `tx`, and makes it the handle of the spawn request `requestId`. */
export async function addRecord(
	tx: Tx,
	requestId: string,
	child: {
		readonly caller: string;
		readonly conversationId: ConversationId;
		readonly name: string | undefined;
		readonly kind: ChildKind | undefined;
	},
): Promise<void> {
	const current = await tx.doc(ChildRecords);
	let fresh = randomBytes(3).toString("hex");

	while (Object.hasOwn(current.children, fresh)) fresh = randomBytes(3).toString("hex");

	let record: ChildRecord = {
		caller: child.caller,
		createdAt: new Date().toISOString(),
		conversationId: child.conversationId,
		requests: [],
		read: 0,
	};

	if (child.name !== undefined) record = { name: child.name, ...record };

	if (child.kind !== undefined) record = { ...record, kind: child.kind };
	current.children[fresh] = record;
	current.requests[requestId] = fresh;
}

/** Whether the conversation `conversationId` is an RLM child: a child that `rlm` spawned. */
export function isRlmChild(state: Readonly<ChildrenState> | null | undefined, conversationId: ConversationId): boolean {
	return Object.values(state?.children ?? {}).some(
		(record) => record.kind === "rlm" && record.conversationId === conversationId,
	);
}

export async function renameRecord(harness: Harness, handle: string, name: string): Promise<void> {
	await harness.commit(async (tx) => {
		const record = (await tx.doc(ChildRecords)).children[handle];

		if (record !== undefined) record.name = name;
	}, context);
}

/** Removes the records of the children whose conversation ID is in `closed`, and the spawn requests that name them. */
export async function removeRecords(harness: Harness, closed: ReadonlySet<string>): Promise<void> {
	await harness.commit(async (tx) => {
		const state = await tx.doc(ChildRecords);

		const removed = new Set(
			Object.keys(state.children).filter((handle) => {
				const child = state.children[handle];

				return child !== undefined && closed.has(String(child.conversationId));
			}),
		);

		for (const handle of removed) delete state.children[handle];

		for (const [requestId, handle] of Object.entries(state.requests)) {
			if (removed.has(handle)) delete state.requests[requestId];
		}
	}, context);
}

/** The `[handle, record]` entries of `state`, oldest child first. */
export function recordsByAge(state: Readonly<ChildrenState> | null | undefined): [string, ChildRecord][] {
	return Object.entries(state?.children ?? {}).sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Adds `requestId` to the requests of `handle` that a `wait` gives the answers of, in `tx`, the commit that makes it the
 * child's last request. Without `notify`, its answer is not pushed. A repeated request is not added. It is the only
 * writer of `requests` of a record.
 */
export async function addRequest(
	tx: Tx,
	handle: string,
	requestId: string,
	options: { readonly notify: boolean },
): Promise<void> {
	const record = (await tx.doc(ChildRecords)).children[handle];

	if (record === undefined || record.requests.some((request) => request.id === requestId)) return;
	record.requests.push({ id: requestId, notify: options.notify });
}

/**
 * Marks the requests of `handle` up to `read` as read; `read` never moves back. After a push, `pushed` is the request
 * whose answer the push gave last, so that a `wait` for it gives no new answer.
 */
export async function markRead(harness: Harness, handle: string, read: number, pushed?: string): Promise<void> {
	await harness.commit(async (tx) => {
		const record = (await tx.doc(ChildRecords)).children[handle];

		if (record === undefined) return;
		record.read = Math.max(record.read, read);

		if (pushed !== undefined) record.pushed = pushed;
	}, context);
}

const PUSH_PREFIX = "push:";

/** The request ID of the push input that gives the answers of `handle` up to `read`. */
export function pushRequest(handle: string, read: number): string {
	return `${PUSH_PREFIX}${handle}:${read}`;
}

/** Whether `requestId` is the input of a push, which a conversation gets from its children. */
export function isPushRequest(requestId: string): boolean {
	return requestId.startsWith(PUSH_PREFIX);
}

/** The record of `handle` in the `ChildRecords` value `state`. */
export function recordOf(state: Readonly<ChildrenState> | null | undefined, handle: string): ChildRecord | undefined {
	return state != null && Object.hasOwn(state.children, handle) ? state.children[handle] : undefined;
}

/** The `detail` of a failed turn that is an error object. */
const ErrorDetail = Type.Object({ message: Type.String() });

/** Whether `record` has a request with `notify` whose answer no `wait` and no push gave. */
export function unreadNotify(record: Readonly<ChildRecord>): boolean {
	return record.requests.slice(record.read).some((request) => request.notify);
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
 * `atStart` the requests of the record when the wait started. `cut` changes the text of each answer and failure.
 */
export async function unreadAnswers(
	child: Child,
	handle: string,
	record: Readonly<ChildRecord>,
	main: string | null,
	answer: Answer,
	atStart: readonly ChildRequest[],
	waiting: Context,
	cut: (text: string) => string = (text) => text,
): Promise<UnreadAnswers> {
	const unread = unreadBefore(record.requests, record.read, main, atStart);
	const earlier: Answer[] = [];

	for (const requestId of unread.ids) {
		const before = await child.settled(waiting, requestId);

		// A steer goes into the turn that was running, so its request can share that turn's answer.
		if (!("entry" in before && "entry" in answer && before.entry === answer.entry)) earlier.push(before);
	}

	const texts = earlier.map((before) => {
		const text = answerText(handle, before);

		return text.failed ? `(no answer: ${cut(text.text)})` : cut(text.text);
	});

	const last = answerText(handle, answer);
	const lastText = cut(last.text);
	const all = [...texts, lastText];
	const parts = all.map((text, index) => `--- Answer ${index + 1} of ${all.length} ---\n${text}`);

	const text = texts.length === 0 ? lastText : `${all.length} unread answers, oldest first.\n\n${parts.join("\n\n")}`;

	return { text, failed: last.failed, read: unread.read };
}

/** The requests whose answers a wait gives before its own, and the new `read` of the child record. */
type Unread = { readonly ids: readonly string[]; readonly read: number };

/**
 * The requests of `requests` from `read` on that a wait for `main` gives before the answer to `main`, and the new `read`.
 * When `main` is a request of the caller, they are the ones before it, and `main` counts as read; a send after it
 * stays unread. Otherwise, such as for the input of a mirror session, they are the caller's requests known when the wait started.
 */
function unreadBefore(
	requests: readonly ChildRequest[],
	read: number,
	main: string | null,
	atStart: readonly ChildRequest[],
): Unread {
	const index = main === null ? -1 : requests.findIndex((request) => request.id === main);

	if (index >= read) return { ids: requests.slice(read, index).map((request) => request.id), read: index + 1 };

	if (index >= 0) return { ids: [], read };

	return { ids: atStart.slice(read).map((request) => request.id), read: Math.max(read, atStart.length) };
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
