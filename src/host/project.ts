/**
 * The store of the project: the persons that the user talks with, the threads of messages with them, the rules and the
 * terms of the project, and the parts of the vault that explain them. Each list is one document of the session, and
 * each thread is an ownerless conversation whose entries are its messages. The requests of the host change them with
 * these functions, each in its own commit.
 */
import type { Context } from "@earendil-works/chord/context";
import type {
	ConversationId,
	Cursor,
	JsonObject,
	DocumentReader,
	EntryId,
	Harness,
	Tx,
} from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import {
	type Author,
	MESSAGE_KIND,
	type Message,
	type MessageLog,
	type Part,
	type PartAdd,
	type PartFilter,
	type PartList,
	PARTS_KIND,
	type Person,
	type PersonAdd,
	type PersonList,
	PERSONS_KIND,
	type Rule,
	type RuleFilter,
	type RuleList,
	type RuleSet,
	RULES_KIND,
	type Term,
	type TermList,
	type TermSet,
	TERMS_KIND,
	type Thread,
	type ThreadAdd,
	type ThreadList,
	type ThreadMessages,
	THREADS_KIND,
} from "../protocol/project.ts";

/** The number of entries that one page of a thread read gives. */
const PAGE = 200;

const Persons = sessionDoc<PersonList>(PERSONS_KIND, () => ({ persons: [] }));
const Threads = sessionDoc<ThreadList>(THREADS_KIND, () => ({ threads: [] }));
const Rules = sessionDoc<RuleList>(RULES_KIND, () => ({ rules: [] }));
const Terms = sessionDoc<TermList>(TERMS_KIND, () => ({ terms: [] }));
const Parts = sessionDoc<PartList>(PARTS_KIND, () => ({ parts: [] }));

/** The data of the entry of a message. The entry has no model message: no model reads a thread. */
type MessageData = Omit<Message, "id" | "thread">;

const MessageEntry = durable.defineEntry<MessageData>(MESSAGE_KIND);

/** Adds a person with the next ID of the list, and gives it. */
export async function addPerson(tx: Tx, input: PersonAdd): Promise<Person> {
	const list = await tx.doc(Persons);
	const person: Person = { id: nextId(list.persons), name: input.name };
	list.persons.push({ ...person });

	return person;
}

/** Adds a thread with `persons` in a new ownerless conversation, whose ID is the ID of the thread, and gives it. */
export async function addThread(tx: Tx, input: ThreadAdd): Promise<Thread> {
	const persons = await tx.doc(Persons);

	for (const id of input.persons) known(persons.persons, id, "person");
	const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
	const thread: Thread = { id: conversation.id, topic: input.topic, persons: [...input.persons] };
	(await tx.doc(Threads)).threads.push(copyThread(thread));

	return thread;
}

/**
 * Adds a message to the thread `input.thread`, with the state `received` for a message in and `draft` for a message out,
 * logged by the caller `by`, and gives it. `at` defaults to now. The `last` of the thread becomes `at` when `at` is later.
 */
export async function logMessage(tx: Tx, input: MessageLog, by: string): Promise<Message> {
	const thread = known((await tx.doc(Threads)).threads, input.thread, "thread");
	await knownAuthor(tx, input.from);

	const data: MessageData = {
		from: input.from,
		direction: input.direction,
		state: input.direction === "in" ? "received" : "draft",
		at: input.at ?? Date.now(),
		text: input.text,
		by,
	};

	const entry = await tx.appendEntry(MessageEntry, conversationId(input.thread), { data });
	thread.last = Math.max(thread.last ?? data.at, data.at);

	return { id: entry.id, thread: input.thread, ...data };
}

/**
 * Adds or changes a rule for the caller `by`, and gives it. A new rule has the status `open` by default, and retires the rule that it
 * replaces; the retired rule keeps its own author and source. A change of a rule makes each part that explains it, or the rule that it replaces, stale.
 */
export async function setRule(tx: Tx, change: RuleSet, by: string): Promise<Rule> {
	if (change.id !== undefined && change.replaces !== undefined) {
		throw new Error("A change of a rule cannot replace a rule: set replaces on a new rule");
	}

	await knownSource(tx, change.source);
	await knownAuthor(tx, change.saidBy);
	const list = await tx.doc(Rules);
	const at = Date.now();
	const changed: number[] = [];
	let rule: Rule;

	if (change.id === undefined) {
		const replaced = change.replaces === undefined ? undefined : known(list.rules, change.replaces, "rule");
		rule = {
			id: nextId(list.rules),
			name: change.name,
			kind: change.kind,
			value: change.value,
			status: change.status ?? "open",
			saidBy: change.saidBy,
			source: change.source,
			at,
			by,
		};

		if (replaced !== undefined) {
			rule.replaces = replaced.id;
			Object.assign(replaced, { status: "retired", at, by });
			changed.push(replaced.id);
		}

		list.rules.push(rule);
	} else {
		rule = known(list.rules, change.id, "rule");
		Object.assign(rule, { saidBy: change.saidBy, source: change.source, at, by });

		if (change.name !== undefined) rule.name = change.name;

		if (change.kind !== undefined) rule.kind = change.kind;

		if (change.value !== undefined) rule.value = change.value;

		if (change.status !== undefined) rule.status = change.status;
		changed.push(rule.id);
	}

	await markStale(tx, "rules", changed);

	// A draft cannot be used after its commit, so the rule is a copy.
	return { ...rule };
}

/** Adds or changes a term for the caller `by`, and gives it. A change of a term makes each part that explains it stale. */
export async function setTerm(tx: Tx, change: TermSet, by: string): Promise<Term> {
	await knownSource(tx, change.source);
	await knownAuthor(tx, change.saidBy);
	const list = await tx.doc(Terms);
	const at = Date.now();
	let term: Term;

	if (change.id === undefined) {
		term = {
			id: nextId(list.terms),
			name: change.name,
			meaning: change.meaning,
			avoid: [...(change.avoid ?? [])],
			saidBy: change.saidBy,
			source: change.source,
			at,
			by,
		};
		list.terms.push(term);
	} else {
		term = known(list.terms, change.id, "term");
		Object.assign(term, { saidBy: change.saidBy, source: change.source, at, by });

		if (change.name !== undefined) term.name = change.name;

		if (change.meaning !== undefined) term.meaning = change.meaning;

		if (change.avoid !== undefined) term.avoid = [...change.avoid];
		await markStale(tx, "terms", [term.id]);
	}

	return { ...term, avoid: [...term.avoid] };
}

/** Adds a part that explains `rules` and `terms`, checked now by the caller `by`, and gives it. */
export async function addPart(tx: Tx, input: PartAdd, by: string): Promise<Part> {
	const rules = (await tx.doc(Rules)).rules;
	const terms = (await tx.doc(Terms)).terms;

	for (const id of input.rules) known(rules, id, "rule");

	for (const id of input.terms) known(terms, id, "term");
	const list = await tx.doc(Parts);

	const part: Part = {
		id: nextId(list.parts),
		kind: input.kind,
		path: input.path,
		rules: [...input.rules],
		terms: [...input.terms],
		checked: Date.now(),
		stale: false,
		by,
	};

	list.parts.push(copyPart(part));

	return part;
}

/** Marks the part `id` checked now by the caller `by` and not stale, and gives it. */
export async function checkPart(tx: Tx, id: number, by: string): Promise<Part> {
	const part = known((await tx.doc(Parts)).parts, id, "part");
	Object.assign(part, { checked: Date.now(), stale: false, by });

	return copyPart(part);
}

/** The persons, in ID order. */
export async function readPersons(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<PersonList> {
	const list = await reader.snapshot(Persons, context);

	return { persons: (list?.persons ?? []).map((person) => ({ ...person })) };
}

/** The threads, in ID order. */
export async function readThreads(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<ThreadList> {
	const list = await reader.snapshot(Threads, context);

	return { threads: (list?.threads ?? []).map(copyThread) };
}

/** The thread `id` and its messages, oldest first. */
export async function readThread(
	harness: Pick<Harness, "snapshot" | "conversation">,
	id: number,
	context: Context,
): Promise<ThreadMessages> {
	const thread = known((await readThreads(harness, context)).threads, id, "thread");

	return { thread, messages: await readMessages(harness, id, context) };
}

/** The messages of the thread `id`, oldest first. */
export async function readMessages(
	harness: Pick<Harness, "conversation">,
	id: number,
	context: Context,
): Promise<Message[]> {
	const conversation = await harness.conversation(conversationId(id), context);

	if (conversation === undefined) throw new Error(`Unknown thread: ${id}`);
	const messages: Message[] = [];
	let cursor: Cursor | undefined;

	do {
		const page = await conversation.entries({ order: "ascending" }, PAGE, cursor, context);

		for (const entry of page.items) {
			if (MessageEntry.is(entry)) messages.push({ id: entry.id, thread: id, ...entry.data });
		}

		cursor = page.next;
	} while (cursor !== undefined);

	return messages;
}

/** The messages of the thread `id` in the state `draft`, oldest first. */
export async function readDrafts(
	harness: Pick<Harness, "conversation">,
	id: number,
	context: Context,
): Promise<Message[]> {
	const messages = await readMessages(harness, id, context);

	return messages.filter((message) => message.state === "draft");
}

/** The rules, in ID order: with `filter`, only those of its kind and its status. */
export async function readRules(
	reader: Pick<DocumentReader, "snapshot">,
	filter: RuleFilter,
	context: Context,
): Promise<RuleList> {
	const list = await reader.snapshot(Rules, context);

	const rules = (list?.rules ?? []).filter(
		(rule) =>
			(filter.kind === undefined || rule.kind === filter.kind) &&
			(filter.status === undefined || rule.status === filter.status),
	);

	return { rules: rules.map((rule) => ({ ...rule })) };
}

/** The terms, in ID order. */
export async function readTerms(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<TermList> {
	const list = await reader.snapshot(Terms, context);

	return { terms: (list?.terms ?? []).map((term) => ({ ...term, avoid: [...term.avoid] })) };
}

/** The parts, in ID order: with `filter`, only those that explain its rule or its term. */
export async function readParts(
	reader: Pick<DocumentReader, "snapshot">,
	filter: PartFilter,
	context: Context,
): Promise<PartList> {
	const list = await reader.snapshot(Parts, context);

	const parts = (list?.parts ?? []).filter(
		(part) =>
			(filter.rule === undefined || part.rules.includes(filter.rule)) &&
			(filter.term === undefined || part.terms.includes(filter.term)),
	);

	return { parts: parts.map(copyPart) };
}

function sessionDoc<T extends JsonObject>(kind: string, initial: () => T) {
	return durable.defineDoc<T>({ kind, version: 1, scope: "session", checkpointWhen: () => false, initial });
}

/** Makes each part that explains one of `ids` of `field` stale. */
async function markStale(tx: Tx, field: "rules" | "terms", ids: readonly number[]): Promise<void> {
	if (ids.length === 0) return;

	for (const part of (await tx.doc(Parts)).parts) {
		if (part[field].some((id) => ids.includes(id))) part.stale = true;
	}
}

function nextId(items: readonly { readonly id: number }[]): number {
	return (items.at(-1)?.id ?? 0) + 1;
}

function known<T extends { readonly id: number }>(items: readonly T[], id: number, name: string): T {
	const item = items.find((found) => found.id === id);

	if (item === undefined) throw new Error(`Unknown ${name}: ${id}`);

	return item;
}

async function knownAuthor(tx: Tx, author: Author): Promise<void> {
	if (author !== "user") known((await tx.doc(Persons)).persons, author, "person");
}

async function knownSource(tx: Tx, id: number): Promise<void> {
	if ((await tx.entry(MessageEntry, entryId(id))) === undefined) throw new Error(`Unknown message: ${id}`);
}

function copyThread(thread: Thread): Thread {
	return { ...thread, persons: [...thread.persons] };
}

function copyPart(part: Part): Part {
	return { ...part, rules: [...part.rules], terms: [...part.terms] };
}

function conversationId(id: number): ConversationId {
	// SAFETY: a thread ID is the ID of the conversation that `addThread` created.
	return id as ConversationId;
}

function entryId(id: number): EntryId {
	// SAFETY: the store gives `undefined` for an ID of no message entry.
	return id as EntryId;
}
