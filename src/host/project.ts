/**
 * The store of the project: the persons that the user talks with, the threads of messages with them, the rules of the
 * project, the tool calls that the gate held, and the parleys and their asks. Each list is one document of the session, and
 * each thread is an ownerless conversation whose entries are its messages. The states of the messages out are in the
 * outbox, a document of the session, because an entry cannot change. The requests of the host change them with
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
import { Value } from "typebox/value";
import {
	type AnswerInput,
	type Ask,
	askAnswerText,
	type AskList,
	type AskOption,
	type AskRef,
	type AskRound,
	ASKS_KIND,
	askTransition,
	type AskWrite,
	type Author,
	HELD_KIND,
	type HeldAction,
	type HeldInput,
	type HeldList,
	MESSAGE_KIND,
	type Message,
	type MessageLog,
	type MessageMarkInput,
	type MessageState,
	messageTransition,
	OUTBOX_KIND,
	type Parley,
	type ParleyAsks,
	type ParleyEnd,
	type ParleyFrame,
	type ParleyList,
	PARLEYS_KIND,
	parleyText,
	type Person,
	type PersonAdd,
	type PersonList,
	PERSONS_KIND,
	type Rule,
	type RuleFilter,
	type RuleList,
	type RuleSet,
	RULES_KIND,
	type Thread,
	type ThreadAdd,
	type ThreadList,
	type ThreadMessages,
	THREADS_KIND,
} from "../protocol/project.ts";
import { dropParleyAnswers, queueAnswers, type UserAnswerInput } from "./user-answers.ts";

/** The number of entries that one page of a thread read gives. */
const PAGE = 200;

const Persons = sessionDoc<PersonList>(PERSONS_KIND, () => ({ persons: [] }));
const Threads = sessionDoc<ThreadList>(THREADS_KIND, () => ({ threads: [] }));
const Rules = sessionDoc<RuleList>(RULES_KIND, () => ({ rules: [] }));
const Held = sessionDoc<HeldList>(HELD_KIND, () => ({ held: [] }));
const Parleys = sessionDoc<ParleyList>(PARLEYS_KIND, () => ({ parleys: [] }));
const Asks = sessionDoc<AskList>(ASKS_KIND, () => ({ asks: [] }));
const Outbox = sessionDoc<{ messages: OutState[] }>(OUTBOX_KIND, () => ({ messages: [] }));

/**
 * The data of the entry of a message. The entry has no model message: no model reads a thread. Its state is in the
 * outbox for a message out, and `received` for a message in.
 */
type MessageData = Omit<Message, "id" | "thread" | "state">;

/** A message with no state: the data of its entry, its ID and its thread. */
export type StoredMessage = MessageData & { id: number; thread: number };

/**
 * The state of the message out `id` of the thread `thread`, written at `written`, and changed last at `at` by the caller
 * `by`.
 */
export type OutState = { id: number; thread: number; state: MessageState; written: number; at: number; by: string };

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
 * A message in from a person of the thread is a reply to each message out of the thread that waits and is not later:
 * a draft becomes `sent`, and a sent message `answered`.
 */
export async function logMessage(tx: Tx, input: MessageLog, by: string): Promise<Message> {
	const thread = known((await tx.doc(Threads)).threads, input.thread, "thread");
	await knownAuthor(tx, input.from);
	const at = input.at ?? Date.now();
	const data: MessageData = { from: input.from, direction: input.direction, at, text: input.text, by };
	const outbox = await tx.doc(Outbox);
	const entry = await tx.appendEntry(MessageEntry, conversationId(input.thread), { data });
	thread.last = Math.max(thread.last ?? at, at);

	if (input.direction === "out")
		outbox.messages.push({ id: entry.id, thread: input.thread, state: "draft", written: at, at, by });
	else if (input.from !== "user" && thread.persons.includes(input.from)) reply(outbox.messages, input.thread, at, by);

	return joinMessage({ id: entry.id, thread: input.thread, ...data }, outStates(outbox.messages));
}

/** Moves each message out of the thread `thread` that was written at `at` or before with a reply by the caller `by`. */
function reply(messages: OutState[], thread: number, at: number, by: string): void {
	const now = Date.now();

	for (const out of messages) {
		const state = out.thread === thread && out.written <= at ? messageTransition(out.state, "reply") : undefined;

		if (state !== undefined) Object.assign(out, { state, at: now, by });
	}
}

/**
 * Marks the message out `input.message` with `input.state` for the caller `by`, and gives it. A message in, and a mark
 * that its state cannot take, fail.
 */
export async function markMessage(tx: Tx, input: MessageMarkInput, by: string): Promise<Message> {
	const { message: id } = input;
	const entry = await tx.entry(MessageEntry, entryId(id));

	if (entry === undefined) throw new Error(`Unknown message: ${id}`);
	const out = (await tx.doc(Outbox)).messages.find((found) => found.id === id);

	if (out === undefined) throw new Error(`Message ${id} is a message in: only a message out has a mark`);
	const state = messageTransition(out.state, input.state);

	if (state === undefined) throw new Error(`Message ${id} is ${out.state}: it cannot become ${input.state}`);
	Object.assign(out, { state, at: Date.now(), by });

	return joinMessage({ id, thread: out.thread, ...entry.data }, outStates([out]));
}

/**
 * Marks each message out of `ids` that the mark `sent` can change as sent by the caller `by`. An ID of another message,
 * or of no message, changes nothing.
 */
export async function markSent(tx: Tx, ids: readonly number[], by: string): Promise<void> {
	const at = Date.now();

	for (const out of (await tx.doc(Outbox)).messages) {
		const state = ids.includes(out.id) ? messageTransition(out.state, "sent") : undefined;

		if (state !== undefined) Object.assign(out, { state, at, by });
	}
}

/** The state of each message out, in ID order. */
export async function readOutbox(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<OutState[]> {
	const list = await reader.snapshot(Outbox, context);

	return (list?.messages ?? []).map((out) => ({ ...out }));
}

/**
 * Adds or changes a rule for the caller `by`, and gives it. A new rule has the status `open` by default, and retires the rule that it
 * replaces; the retired rule keeps its own author and source.
 */
export async function setRule(tx: Tx, change: RuleSet, by: string): Promise<Rule> {
	if (change.id !== undefined && change.replaces !== undefined) {
		throw new Error("A change of a rule cannot replace a rule: set replaces on a new rule");
	}

	await knownSource(tx, change.source);
	await knownAuthor(tx, change.saidBy);
	const list = await tx.doc(Rules);
	const at = Date.now();
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
		}

		list.rules.push(rule);
	} else {
		rule = known(list.rules, change.id, "rule");
		Object.assign(rule, { saidBy: change.saidBy, source: change.source, at, by });

		if (change.name !== undefined) rule.name = change.name;

		if (change.kind !== undefined) rule.kind = change.kind;

		if (change.value !== undefined) rule.value = change.value;

		if (change.status !== undefined) rule.status = change.status;
	}

	// A draft cannot be used after its commit, so the rule is a copy.
	return { ...rule };
}

/**
 * Holds the call `input` of its agent with the state `held`, and gives the held action. A held or dropped action of the
 * same agent and request ID is given again, and no action is added.
 */
export async function holdAction(tx: Tx, input: HeldInput): Promise<HeldAction> {
	const list = await tx.doc(Held);
	const found = heldFor(list.held, input.agent, input.requestId);

	if (found !== undefined) return copyHeld(found);
	const held: HeldAction = { id: nextId(list.held), ...input, state: "held", at: Date.now(), by: input.agent };
	list.held.push(copyHeld(held));

	return held;
}

/** The call that an approved action can run for. */
type RunCall = Pick<HeldInput, "agent" | "tool" | "command" | "requestId">;

/** Approves the held action `id` for the caller `by`, and gives it. An action that is not held fails. */
export async function approveHeld(tx: Tx, id: number, by: string): Promise<HeldAction> {
	return decide(tx, id, { state: "approved", by });
}

/** Drops the held action `id` for the caller `by`, and gives it. An action that is not held fails. */
export async function dropHeld(tx: Tx, id: number, by: string): Promise<HeldAction> {
	return decide(tx, id, { state: "dropped", by });
}

/**
 * Marks the approved action of the call `call` as run by it, and gives it: the action of the same agent, tool and
 * command that ran for no call, or for this call. With no such action, it gives `undefined` and changes nothing.
 */
export async function runApproved(tx: Tx, call: RunCall): Promise<HeldAction | undefined> {
	const list = await tx.doc(Held);
	const found = list.held.find((held) => runsFor(held, call));

	if (found === undefined) return undefined;
	const ran: HeldAction = { ...found, ran: found.ran ?? { requestId: call.requestId, at: Date.now() } };
	list.held[list.held.indexOf(found)] = copyHeld(ran);

	return ran;
}

/**
 * Whether the held action `held` is approved for the agent, tool and command of `call`, and lets it run: it ran for no
 * call, or for this one.
 */
export function runsFor(held: HeldAction, call: RunCall): held is Extract<HeldAction, { readonly state: "approved" }> {
	return (
		held.state === "approved" &&
		held.agent === call.agent &&
		held.tool === call.tool &&
		held.command === call.command &&
		(held.ran === undefined || held.ran.requestId === call.requestId)
	);
}

/** The held or dropped action of the call `requestId` of `agent`. */
export function heldFor(held: readonly HeldAction[], agent: string, requestId: string): HeldAction | undefined {
	return held.find((found) => found.state !== "approved" && found.agent === agent && found.requestId === requestId);
}

/** The held actions, in ID order. */
export async function readHeld(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<HeldList> {
	const list = await reader.snapshot(Held, context);

	return { held: (list?.held ?? []).map(copyHeld) };
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

/** The messages of the thread `id`, oldest first, each with its state in the outbox. */
export async function readMessages(
	harness: Pick<Harness, "snapshot" | "conversation">,
	id: number,
	context: Context,
): Promise<Message[]> {
	// The outbox is read after the entries, so that each message out that they have has its state there.
	const stored = await readStored(harness, id, context);
	const states = outStates(await readOutbox(harness, context));

	return stored.map((message) => joinMessage(message, states));
}

/** The messages of the thread `id`, oldest first, with no state. */
export async function readStored(
	harness: Pick<Harness, "conversation">,
	id: number,
	context: Context,
): Promise<StoredMessage[]> {
	const conversation = await harness.conversation(conversationId(id), context);

	if (conversation === undefined) throw new Error(`Unknown thread: ${id}`);
	const messages: StoredMessage[] = [];
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

/** The state of each message of `outbox`, by message ID. */
export function outStates(outbox: readonly OutState[]): ReadonlyMap<number, MessageState> {
	return new Map(outbox.map((out) => [out.id, out.state]));
}

/**
 * The message `message` with its state: `received` for a message in, and its state in `states` for a message out. A
 * message out has its state in the outbox from the commit that adds it, so a message out with no state fails.
 */
export function joinMessage(message: StoredMessage, states: ReadonlyMap<number, MessageState>): Message {
	if (message.direction === "in") return { ...message, state: "received" };
	const state = states.get(message.id);

	if (state === undefined) throw new Error(`Message ${message.id} is a message out with no state in the outbox`);

	return { ...message, state };
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

/** A parley in the status `open`. */
type OpenParley = Extract<Parley, { readonly status: "open" }>;

/** An ask in the state `answered`. */
type AnsweredAsk = Extract<Ask, { readonly state: "answered" }>;

/** The fields of an ask without its state and its answer. */
type AskBase = Omit<Extract<Ask, { readonly state: "open" }>, "state">;

/**
 * Writes the round `round` with the caller `by` as the asker of its asks, and gives the write: the parley with all of
 * its asks, or the new asks when they have no parley. With `round.parley`, a new slug makes an open parley, which needs a title and a goal, and a known slug must be
 * an open parley, whose fields the frame replaces. The asks of a parley take the next numbers of that parley.
 */
export async function writeRound(tx: Tx, round: AskRound, by: string): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const asks = (await tx.doc(Asks)).asks;
	const at = Date.now();
	const parley = round.parley === undefined ? undefined : frameParley(parleys, round.parley, at, by);
	let n = parley === undefined ? 0 : lastNumber(asks, parley.id);
	const written: Ask[] = [];

	for (const input of round.asks) {
		const ask: Ask = { id: nextId(asks), title: input.title, state: "open", asker: by, at, by };

		if (input.kind !== undefined) ask.kind = input.kind;

		if (input.tension !== undefined) ask.tension = input.tension;

		if (input.options !== undefined) ask.options = input.options.map(copyOption);

		if (input.plan !== undefined) ask.plan = input.plan;

		if (input.view !== undefined) ask.view = input.view;

		if (parley !== undefined) {
			n += 1;
			ask.parley = { id: parley.id, n };
		}

		asks.push(ask);
		written.push(Value.Clone(ask));
	}

	return writeReply(parleys, asks, parley === undefined ? [] : [parley.id], written);
}

/**
 * Writes the answers `answers` for the caller `by`, and gives the write: each parley of the answered asks, with all of
 * its asks, and the answered asks with no parley. Each answer names its ask by ID, or by its number in a parley, and
 * two answers of one ask fail. Each answer replaces the answer of its ask, with its label and its words, as one unit. The answer `ok` to the read-back of
 * a parley, an ask of the parley with no options, makes the parley a contract, once every answer is written: each other
 * ask of the parley must be answered or dropped, and its `design_sense` set. The same commit queues the answers for
 * their askers: one delivery for each asker and parley, with the text of the parley, and one for each answered ask with
 * no parley. An ask whose asker is `by` gets no delivery.
 */
export async function answerAsks(tx: Tx, answers: readonly AnswerInput[], by: string): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const asks = (await tx.doc(Asks)).asks;
	const at = Date.now();
	const written: Ask[] = [];
	const readBacks = new Set<number>();

	for (const input of answers) {
		const ask = resolveAsk(parleys, asks, input);

		if (written.some((each) => each.id === ask.id)) throw new Error(`Ask ${ask.id} has two answers in one write`);
		const parley = ask.parley === undefined ? undefined : openParley(known(parleys, ask.parley.id, "parley"));

		if (askTransition(ask.state, "answer") === undefined)
			throw new Error(`Ask ${ask.id} is ${ask.state}: it takes no answer`);
		const keys = answerKeys(ask);

		if (input.answer !== "own" && !keys.includes(input.answer)) {
			throw new Error(`Ask ${ask.id} takes ${keys.length === 0 ? "own" : `${keys.join(", ")} or own`}`);
		}

		const answered: AnsweredAsk = { ...askBase(ask), state: "answered", answer: input.answer, at, by };

		if (input.label !== undefined) answered.label = input.label;

		if (input.words !== undefined) answered.words = [...input.words];
		asks[asks.indexOf(ask)] = answered;
		written.push(Value.Clone(answered));

		if (parley !== undefined && input.answer === "ok") readBacks.add(parley.id);
	}

	for (const id of readBacks) makeContract(parleys, asks, id, at, by);
	await queueAnswers(tx, deliveries(parleys, asks, written, by));
	const touched = written.flatMap((ask) => (ask.parley === undefined ? [] : [ask.parley.id]));

	return writeReply(parleys, asks, touched, written);
}

/**
 * The reply of a write: each parley of `ids`, once, in ID order, with all of its asks in `asks`, and the asks of
 * `written` with no parley.
 */
function writeReply(parleys: readonly Parley[], asks: readonly Ask[], ids: readonly number[], written: readonly Ask[]) {
	const changed = [...new Set(ids)].sort((a, b) => a - b);

	return {
		parleys: changed.map((id) => ({ parley: Value.Clone(known(parleys, id, "parley")), asks: parleyAsks(asks, id) })),
		asks: written.filter((ask) => ask.parley === undefined),
	} satisfies AskWrite;
}

/**
 * The deliveries of the answered asks `written` to their askers other than `by`, in the order of `written`: one for
 * each asker and parley, with the text of the parley in `parleys` and `asks`, and one for each ask with no parley.
 */
function deliveries(parleys: readonly Parley[], asks: readonly Ask[], written: readonly Ask[], by: string) {
	const queued: UserAnswerInput[] = [];
	const byParley = new Map<string, number[]>();

	for (const ask of written) {
		if (ask.asker === by) continue;

		if (ask.parley === undefined) {
			queued.push({ asker: ask.asker, delivery: { source: "ask", ask: ask.id, text: askAnswerText(ask) } });
			continue;
		}

		const key = `${ask.asker}\n${ask.parley.id}`;
		const found = byParley.get(key);

		if (found !== undefined) {
			found.push(ask.id);
			continue;
		}

		const parley = known(parleys, ask.parley.id, "parley");
		const text = parleyText({ parley, asks: parleyAsks(asks, parley.id) });
		const ids = [ask.id];
		byParley.set(key, ids);
		queued.push({ asker: ask.asker, delivery: { source: "parley", parley: parley.slug, asks: ids, text } });
	}

	return queued;
}

/**
 * Drops the open ask of `ref` for the caller `by`, and gives the write: its parley with all of its asks, or the ask
 * when it has no parley. The ask of a parley that is not open does not change.
 */
export async function dropAsk(tx: Tx, ref: AskRef, by: string): Promise<AskWrite> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const asks = (await tx.doc(Asks)).asks;
	const ask = resolveAsk(parleys, asks, ref);

	if (ask.parley !== undefined) openParley(known(parleys, ask.parley.id, "parley"));

	if (askTransition(ask.state, "drop") === undefined)
		throw new Error(`Ask ${ask.id} is ${ask.state}: only an open ask drops`);
	const dropped: Ask = { ...askBase(ask), state: "dropped", at: Date.now(), by };
	asks[asks.indexOf(ask)] = dropped;

	return writeReply(parleys, asks, ask.parley === undefined ? [] : [ask.parley.id], [Value.Clone(dropped)]);
}

/**
 * Makes the caller `by` the asker of the open asks of the parley `slug`, and gives the parley and its asks. The parley
 * is open or a contract: a contract has no open ask, so its take changes no ask. The answers of the parley that wait in
 * the queue go: the reply has them, and no asker gets them after the take.
 */
export async function takeParley(tx: Tx, slug: string, by: string): Promise<ParleyAsks> {
	const parley = knownParley((await tx.doc(Parleys)).parleys, slug);

	if (parley.status !== "contract") openParley(parley);
	const asks = (await tx.doc(Asks)).asks;
	const at = Date.now();

	for (const ask of asks) {
		if (ask.parley?.id === parley.id && ask.state === "open") Object.assign(ask, { asker: by, at, by });
	}

	await dropParleyAnswers(tx, parley.slug);

	return { parley: Value.Clone(parley), asks: parleyAsks(asks, parley.id) };
}

/** Ends the contract `slug` with the status `status` for the caller `by`, and gives the parley. */
export async function endParley(tx: Tx, slug: string, status: ParleyEnd, by: string): Promise<Parley> {
	const parleys = (await tx.doc(Parleys)).parleys;
	const parley = knownParley(parleys, slug);

	if (parley.status !== "contract") throw new Error(`Parley ${slug} is ${parley.status}: only a contract ends`);
	const ended: Parley = { ...parley, status, at: Date.now(), by };
	parleys[parleys.indexOf(parley)] = ended;

	return Value.Clone(ended);
}

/** The parleys, in ID order. */
export async function readParleys(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<ParleyList> {
	const list = await reader.snapshot(Parleys, context);

	return { parleys: Value.Clone(list?.parleys ?? []) };
}

/** Every ask, in ID order. */
export async function readAsks(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<AskList> {
	const list = await reader.snapshot(Asks, context);

	return { asks: Value.Clone(list?.asks ?? []) };
}

/** The open asks, in ID order. */
export async function readOpenAsks(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<AskList> {
	return { asks: (await readAsks(reader, context)).asks.filter((ask) => ask.state === "open") };
}

/** The ask of `ref`, in any state. */
export async function readAsk(reader: Pick<DocumentReader, "snapshot">, ref: AskRef, context: Context): Promise<Ask> {
	const { parleys } = await readParleys(reader, context);

	return resolveAsk(parleys, (await readAsks(reader, context)).asks, ref);
}

/** The parley `slug` and its asks, in the order of their numbers. */
export async function readParley(
	reader: Pick<DocumentReader, "snapshot">,
	slug: string,
	context: Context,
): Promise<ParleyAsks> {
	const parley = knownParley((await readParleys(reader, context)).parleys, slug);

	return { parley, asks: parleyAsks((await readAsks(reader, context)).asks, parley.id) };
}

/**
 * The open parley of the frame `frame`, written at `at` by the caller `by`: a new parley for a new slug, or the known
 * parley with the fields of the frame.
 */
function frameParley(parleys: Parley[], frame: ParleyFrame, at: number, by: string): OpenParley {
	const { slug } = frame;
	const existing = parleys.find((parley) => parley.slug === slug);
	const found = existing === undefined ? undefined : openParley(existing);
	const title = frame.title ?? found?.title;
	const goal = frame.goal ?? found?.goal;

	if (title === undefined) throw new Error(`Parley ${slug} is new: title is required`);

	if (goal === undefined) throw new Error(`Parley ${slug} is new: goal is required`);
	const parley: OpenParley = { id: found?.id ?? nextId(parleys), slug, title, goal, status: "open", at, by };
	const evidence = frame.evidence ?? found?.evidence;
	const designSense = frame.design_sense ?? found?.design_sense;

	if (evidence !== undefined) parley.evidence = [...evidence];

	if (designSense !== undefined) parley.design_sense = designSense;

	if (found === undefined) parleys.push(parley);
	else parleys[parleys.indexOf(found)] = parley;

	return Value.Clone(parley);
}

/** Makes the parley `id` a contract at `at` for the caller `by`. It needs `design_sense`, and no open ask. */
function makeContract(parleys: Parley[], asks: readonly Ask[], id: number, at: number, by: string): void {
	const parley = openParley(known(parleys, id, "parley"));
	const { design_sense } = parley;

	if (design_sense === undefined) {
		throw new Error(`Parley ${parley.slug} cannot be a contract: design_sense is not set`);
	}

	const open = asks.find((ask) => ask.parley?.id === id && ask.state === "open");

	if (open?.parley !== undefined) {
		throw new Error(`Parley ${parley.slug} cannot be a contract: ask ${open.parley.n} is open`);
	}

	parleys[parleys.indexOf(parley)] = { ...parley, status: "contract", design_sense, at, by };
}

/** `parley` when it is open. A parley in another status fails: its asks do not change. */
function openParley(parley: Parley): OpenParley {
	if (parley.status !== "open") throw new Error(`Parley ${parley.slug} is ${parley.status}: its asks do not change`);

	return parley;
}

/** The ask of `ref` in `asks`: the ask of its ID, or the ask of its number in its parley. */
function resolveAsk<T extends Ask>(parleys: readonly Parley[], asks: readonly T[], ref: AskRef): T {
	if (ref.id !== undefined) return known(asks, ref.id, "ask");
	const parley = knownParley(parleys, ref.slug);
	const ask = asks.find((found) => found.parley?.id === parley.id && found.parley.n === ref.n);

	if (ask === undefined) throw new Error(`Parley ${parley.slug} has no ask ${ref.n}`);

	return ask;
}

function knownParley(parleys: readonly Parley[], slug: string): Parley {
	const parley = parleys.find((found) => found.slug === slug);

	if (parley === undefined) throw new Error(`Unknown parley: ${slug}`);

	return parley;
}

/** The highest number of the asks of the parley `id`, or 0 when it has none. */
function lastNumber(asks: readonly Ask[], id: number): number {
	return Math.max(0, ...asks.flatMap((ask) => (ask.parley?.id === id ? [ask.parley.n] : [])));
}

/** Copies of the asks of the parley `id`, in the order of their numbers. */
function parleyAsks(asks: readonly Ask[], id: number): Ask[] {
	return asks.flatMap((ask) => (ask.parley?.id === id ? [Value.Clone(ask)] : []));
}

/** The fields of `ask` without its state and its answer. */
function askBase(ask: Ask): AskBase {
	if (ask.state !== "answered") {
		const { state: _state, ...base } = ask;

		return base;
	}

	const { state: _state, answer: _answer, label: _label, words: _words, ...base } = ask;

	return base;
}

/** The keys that `ask` takes besides `own`: the keys of its options, or `ok` when it is the read-back of a parley. */
function answerKeys(ask: Ask): string[] {
	if (ask.options !== undefined) return ask.options.map((option) => option.key);

	return ask.parley === undefined ? [] : ["ok"];
}

/** A copy of `option` with only the fields of an option. */
function copyOption(option: AskOption): AskOption {
	const copy: AskOption = { key: option.key, label: option.label };

	if (option.gains !== undefined) copy.gains = [...option.gains];

	if (option.costs !== undefined) copy.costs = [...option.costs];

	return copy;
}

/** A document of the session of the kind `kind`, which starts as `initial()`. */
export function sessionDoc<T extends JsonObject>(kind: string, initial: () => T) {
	return durable.defineDoc<T>({ kind, version: 1, scope: "session", checkpointWhen: () => false, initial });
}

function nextId(items: readonly { readonly id: number }[]): number {
	return (items.at(-1)?.id ?? 0) + 1;
}

function known<T extends { readonly id: number }>(items: readonly T[], id: number, name: string): T {
	const item = items.find((found) => found.id === id);

	if (item === undefined) throw new Error(`Unknown ${name}: ${id}`);

	return item;
}

/** Sets the held action `id` to the decision `decision`, and gives it. An action that is not held fails. */
async function decide(
	tx: Tx,
	id: number,
	decision: Pick<Extract<HeldAction, { readonly state: "approved" | "dropped" }>, "state" | "by">,
): Promise<HeldAction> {
	const list = await tx.doc(Held);
	const found = known(list.held, id, "held action");

	if (found.state !== "held") throw new Error(`Held action ${id} is ${found.state}, not held`);
	const decided: HeldAction = { ...found, ...decision, at: Date.now() };
	list.held[list.held.indexOf(found)] = copyHeld(decided);

	return decided;
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

function copyHeld(held: HeldAction): HeldAction {
	return held.state === "approved" && held.ran !== undefined ? { ...held, ran: { ...held.ran } } : { ...held };
}

function conversationId(id: number): ConversationId {
	// SAFETY: a thread ID is the ID of the conversation that `addThread` created.
	return id as ConversationId;
}

function entryId(id: number): EntryId {
	// SAFETY: the store gives `undefined` for an ID of no message entry.
	return id as EntryId;
}
