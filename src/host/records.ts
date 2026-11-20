/**
 * The `ChildRecords` of the host, one per child, with what each child serves and their read marks: which requests a
 * `wait` or a push gives the answers of, their text, and whether a child holds its caller.
 */
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { type ConversationId, defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Answer, Child } from "../children/library.ts";
import { cutAnswer } from "../protocol/answer-cut.ts";
import type { Served } from "../protocol/requests.ts";
import { AGENT_HANDLE } from "../protocol/target.ts";
import { boundedReplay } from "./checkpoint.ts";
import type { ItemIndex } from "./item-index.ts";

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
	/** What the child serves, fixed at its spawn. */
	serves: ChildServes;
	/**
	 * Whether the end of what the child serves was applied to it: `ended` when the rule ended it, `passed` when the
	 * child was already ended, by a `stop` or the end of its session. The rule ends a child once, so a resumed child
	 * stays. `due` is an end to apply: the move of the todos to items gives it to a child of a todo that was done or
	 * dropped, so the rule ends the child once its own list is clear.
	 */
	servedEnd?: "ended" | "passed" | "due";
};

/**
 * What a child serves, as its record keeps it: what an agent serves, except the project, and an item with no ID. The
 * `serves` edge of the item holds the ID.
 */
export type ChildServes = Exclude<Served, { readonly kind: "project" | "item" }> | { kind: "item" };

/** What a record of version 5 served before the work items: the todo `id` of the list of the project. */
export const OldTodoServes = Type.Object({ kind: Type.Literal("todo"), id: Type.Integer() });

/** A record of version 4, which has no `serves`. */
type RecordV4 = Omit<ChildRecord, "serves" | "servedEnd">;

type ChildrenV4 = { children: Record<string, RecordV4>; requests: Record<string, string> };

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

/** A record of version 3: a child that a kernel spawned through `rlm` has `kind: "rlm"`. */
const RecordV3 = Type.Object({
	name: Type.Optional(Type.String()),
	caller: Type.String(),
	createdAt: Type.String(),
	conversationId: Type.Unsafe<ConversationId>(Type.Integer()),
	requests: Type.Array(Type.Object({ id: Type.String(), notify: Type.Boolean() })),
	read: Type.Number(),
	pushed: Type.Optional(Type.String()),
	kind: Type.Optional(Type.String()),
});

const ChildrenV3 = Type.Object({
	children: Type.Record(Type.String(), RecordV3),
	requests: Type.Record(Type.String(), Type.String()),
});

/**
 * The children by handle, and the handle of each spawn request ID. Version 6 has no child that serves a todo: the move
 * of the todos to items at the first start of a host rewrites the records of version 5 that serve one (`OldTodoServes`).
 * Version 5 has what each child serves; the children
 * of an older version serve their spawner. Version 4 has no kind of a child; version 3 marked the children of a kernel
 * with `kind: "rlm"`. Version 3 keeps the requests of a child in one list; version 2 kept their IDs in `sent` and those
 * without `notify` in `quiet`. Version 2 leaves each child's last request to the children library; a store with
 * version 1 has children that the library does not know.
 */
export const ChildRecords = defineDoc<ChildrenState>({
	kind: "subagent.children",
	version: 6,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ children: {}, requests: {} }),
	migrate: (value, fromVersion) => {
		if (fromVersion < 2) throw new OldChildRecordsError(`subagent.children has version ${fromVersion}`);

		if (fromVersion === 5) {
			// SAFETY: a value of version 5 has the shape of version 6, except a `serves` of `OldTodoServes`, which the move
			// of the todos to items rewrites at the first start of the host, before it serves a request.
			return value as ChildrenState;
		}

		if (fromVersion === 2) return migrateV4(migrateV2(Value.Parse(ChildrenV2, value)));

		// A record of version 4 is a record of version 3 without a kind.
		return migrateV4(migrateV3(Value.Parse(ChildrenV3, value)));
	},
});

/** Makes each child of `state` serve its spawner. */
function migrateV4(state: ChildrenV4): ChildrenState {
	const serves: ChildServes = { kind: "spawner" };

	const children = Object.fromEntries(
		Object.entries(state.children).map(([handle, record]) => [handle, { ...record, serves }]),
	);

	return { children, requests: state.requests };
}

/** Drops the kind of each child of `state`. */
function migrateV3(state: Static<typeof ChildrenV3>): ChildrenV4 {
	for (const record of Object.values(state.children)) delete record.kind;

	return state;
}

function migrateV2(state: Static<typeof ChildrenV2>): ChildrenV4 {
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
		readonly serves: ChildServes;
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
		serves: child.serves,
	};

	if (child.name !== undefined) record = { name: child.name, ...record };
	current.children[fresh] = record;
	current.requests[requestId] = fresh;
}

export async function renameRecord(harness: Harness, handle: string, name: string): Promise<void> {
	await harness.commit(async (tx) => {
		const record = (await tx.doc(ChildRecords)).children[handle];

		if (record !== undefined) record.name = name;
	}, context);
}

/**
 * Marks read every request of the records of the children whose conversation ID is in `conversationIds`, so that a
 * stopped child holds no caller. An answer that was not pushed is not pushed. With `servedEnded`, it also marks each of
 * these records as ended by the end of what it serves (`servedEnd` is `ended`).
 */
export async function markAllRead(
	harness: Harness,
	conversationIds: ReadonlySet<string>,
	options: { readonly servedEnded: boolean },
): Promise<void> {
	await harness.commit(async (tx) => {
		for (const record of Object.values((await tx.doc(ChildRecords)).children)) {
			if (!conversationIds.has(String(record.conversationId))) continue;
			record.read = record.requests.length;

			if (options.servedEnded) record.servedEnd = "ended";
		}
	}, context);
}

/**
 * Marks the record of `handle` as passed by the end of what it serves (`servedEnd` is `passed`), unless the rule ended
 * it: the child was already ended, so the rule does not end it again, and its deliveries do not wait.
 */
export async function markServedPassed(harness: Harness, handle: string): Promise<void> {
	await harness.commit(async (tx) => {
		const record = (await tx.doc(ChildRecords)).children[handle];

		if (record !== undefined && record.servedEnd !== "ended") record.servedEnd = "passed";
	}, context);
}

/**
 * What the child of `record` serves, as its info and its node give it. For a record that serves an item, `items` gives
 * the item of the child, and a child that no `serves` edge names serves nothing.
 */
export function childServed(record: Readonly<ChildRecord>, items: Pick<ItemIndex, "childItem">): Served | undefined {
	if (record.serves.kind !== "item") return record.serves;
	const id = items.childItem(record.conversationId);

	return id === undefined ? undefined : { kind: "item", id };
}

/** The `[handle, record]` entries of `state`, oldest child first. */
export function recordsByAge(state: Readonly<ChildrenState> | null | undefined): [string, ChildRecord][] {
	return Object.entries(state?.children ?? {}).sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
}

/** The `[handle, record]` entry of `entries` whose child has the conversation ID `conversationId`, if any. */
export function conversationEntry<E extends readonly [string, ChildRecord]>(
	entries: readonly E[],
	conversationId: string,
): E | undefined {
	return entries.find(([, record]) => String(record.conversationId) === conversationId);
}

/**
 * The handle of `caller`, a conversation ID: `agent` for `rootId`, the conversation of the project agent, or the handle
 * of the child of `entries` whose conversation it is. Nothing for another caller.
 */
export function callerHandle(
	rootId: ConversationId,
	entries: readonly (readonly [string, ChildRecord])[],
	caller: string,
): string | undefined {
	if (caller === String(rootId)) return AGENT_HANDLE;

	return conversationEntry(entries, caller)?.[0];
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
 * `atStart` the requests of the record when the wait started. `cutAnswer` cuts the text of each answer and failure.
 */
export async function unreadAnswers(
	child: Child,
	handle: string,
	record: Readonly<ChildRecord>,
	main: string | null,
	answer: Answer,
	atStart: readonly ChildRequest[],
	waiting: Context,
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

		return text.failed ? `(no answer: ${cutAnswer(text.text)})` : cutAnswer(text.text);
	});

	const last = answerText(handle, answer);
	const lastText = cutAnswer(last.text);
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
