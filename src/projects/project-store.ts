/**
 * `project.sqlite`: the persons, the threads with their persons, the messages, the rules and the held actions of the
 * project, and the pending deliveries, as plain tables beside `durable.sqlite`. The host is the only writer: a write is
 * one synchronous transaction, and the store tells its listeners what changed after the commit. Each table gives the
 * next ID of its list and never gives an ID again. `store load` writes a store file into the empty tables with the IDs
 * of the file. The schema also has the tables of the parleys and the items with their edges.
 */
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { type Author, HeldAction, Message, Person, Rule, type RuleFilter, Thread } from "../protocol/project.ts";
import { FileMessage, type StoreFile } from "../protocol/store-file.ts";

/** The file of the store, in the state directory of the project. */
export const PROJECT_STORE_FILE = "project.sqlite";

/**
 * The tables. An author that is `user` is NULL in its person column. The evidence of a parley is a JSON array of texts.
 * An edge keeps the order of its writes by its row ID. A delivery is pending until the host delivered its key once.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS person (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thread (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, last INTEGER);
CREATE TABLE IF NOT EXISTS thread_person (
	thread INTEGER NOT NULL REFERENCES thread (id),
	person INTEGER NOT NULL,
	PRIMARY KEY (thread, person)
);
CREATE TABLE IF NOT EXISTS message (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	thread INTEGER NOT NULL REFERENCES thread (id),
	person INTEGER,
	direction TEXT NOT NULL,
	state TEXT NOT NULL,
	at INTEGER NOT NULL,
	text TEXT NOT NULL,
	"by" TEXT NOT NULL,
	changed_at INTEGER,
	changed_by TEXT
);
CREATE INDEX IF NOT EXISTS message_thread ON message (thread);
CREATE TABLE IF NOT EXISTS rule (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	value TEXT NOT NULL,
	status TEXT NOT NULL,
	said_by INTEGER,
	source INTEGER REFERENCES message (id),
	thread INTEGER REFERENCES thread (id),
	replaces INTEGER,
	at INTEGER NOT NULL,
	"by" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS held (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	request_id TEXT NOT NULL,
	agent TEXT NOT NULL,
	tool TEXT NOT NULL,
	command TEXT NOT NULL,
	rule INTEGER,
	reason TEXT NOT NULL,
	state TEXT NOT NULL,
	ran_request_id TEXT,
	ran_at INTEGER,
	at INTEGER NOT NULL,
	"by" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parley (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	slug TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	goal TEXT NOT NULL,
	evidence TEXT,
	design_sense TEXT,
	status TEXT NOT NULL,
	at INTEGER NOT NULL,
	"by" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS item (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	text TEXT,
	state TEXT NOT NULL,
	at INTEGER NOT NULL,
	"by" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edge (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	"from" TEXT NOT NULL,
	kind TEXT NOT NULL,
	"to" TEXT NOT NULL,
	at INTEGER NOT NULL,
	"by" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_from ON edge ("from");
CREATE INDEX IF NOT EXISTS edge_to ON edge ("to");
CREATE TABLE IF NOT EXISTS delivery (
	"key" TEXT PRIMARY KEY,
	target TEXT NOT NULL,
	text TEXT NOT NULL,
	at INTEGER NOT NULL
);
`;

const MESSAGE_COLUMNS = `id, thread, COALESCE(person, 'user') AS "from", direction, state, at, text, "by", changed_at AS changedAt, changed_by AS changedBy`;

const RULE_COLUMNS = `id, name, kind, value, status, COALESCE(said_by, 'user') AS saidBy, source, thread, replaces, at, "by"`;

const HELD_COLUMNS = `id, request_id AS requestId, agent, tool, command, rule, reason, state, ran_request_id AS ranRequestId, ran_at AS ranAt, at, "by"`;

/** A held action row, with the call that an approved action ran for in two columns. */
const HeldRow = Type.Object({
	...HeldAction.anyOf[0].properties,
	state: Type.String(),
	ranRequestId: Type.Optional(Type.String()),
	ranAt: Type.Optional(HeldAction.anyOf[0].properties.at),
});

/** A pending delivery: the text that goes once for its key to `target`, queued at `at`. */
export const PendingDelivery = Type.Object({
	key: Type.String(),
	target: Type.String(),
	text: Type.String(),
	at: Type.Integer(),
});

export type PendingDelivery = Static<typeof PendingDelivery>;

/** A message row, with the last change of the state of a message out in two columns. */
const MessageRow = Type.Object({
	...Message.properties,
	changedAt: Type.Optional(Message.properties.at),
	changedBy: Type.Optional(Message.properties.by),
});

/** A message out: its state and the last change of its state. */
export type OutMessage = Extract<FileMessage, { direction: "out" }>;

/** The schema of a message out. */
const OutMessage = FileMessage.anyOf[1];

/**
 * A change of a write: an object of a table that it added or changed, as the write committed it, or the ID of a message
 * or a rule that it removed.
 */
export type StoreChange =
	| { readonly kind: "person"; readonly value: Person }
	| { readonly kind: "thread"; readonly value: Thread }
	| { readonly kind: "message"; readonly value: FileMessage }
	| { readonly kind: "rule"; readonly value: Rule }
	| { readonly kind: "held"; readonly value: HeldAction }
	| { readonly kind: "removed"; readonly table: "message" | "rule"; readonly id: number };

/**
 * A listener of the writes. It gets one change for each object that a write changed, in the order of their last change.
 * It must not throw and must not call the store.
 */
export type StoreListener = (changes: readonly StoreChange[]) => void;

/** The reads of the store. */
export class StoreReader {
	protected readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** The persons, in ID order. */
	persons(): Person[] {
		return this.#rows(Person, "SELECT id, name FROM person ORDER BY id");
	}

	/** The person `id`. An ID of no person fails with `Unknown person: <id>`. */
	person(id: number): Person {
		return this.#rows(Person, "SELECT id, name FROM person WHERE id = ?", id)[0] ?? unknown("person", id);
	}

	/** The threads, in ID order, each with its persons in the order that they joined. */
	threads(): Thread[] {
		return this.#threads("SELECT id, topic, last FROM thread ORDER BY id");
	}

	/** The thread `id`. An ID of no thread fails with `Unknown thread: <id>`. */
	thread(id: number): Thread {
		return this.#threads("SELECT id, topic, last FROM thread WHERE id = ?", id)[0] ?? unknown("thread", id);
	}

	/** The messages of the thread `thread`, in ID order. */
	messages(thread: number): FileMessage[] {
		return this.#messages(FileMessage, `SELECT ${MESSAGE_COLUMNS} FROM message WHERE thread = ? ORDER BY id`, thread);
	}

	/** The message `id`. An ID of no message fails with `Unknown message: <id>`. */
	message(id: number): FileMessage {
		return this.findMessage(id) ?? unknown("message", id);
	}

	/** The message `id`, or `undefined` when there is no such message. */
	findMessage(id: number): FileMessage | undefined {
		return this.#messages(FileMessage, `SELECT ${MESSAGE_COLUMNS} FROM message WHERE id = ?`, id)[0];
	}

	/** The messages out, in ID order: with `thread`, only those of that thread. */
	outMessages(thread?: number): OutMessage[] {
		return this.#messages(
			OutMessage,
			`SELECT ${MESSAGE_COLUMNS} FROM message WHERE direction = 'out' AND (?1 IS NULL OR thread = ?1) ORDER BY id`,
			thread ?? null,
		);
	}

	/** The rules, in ID order: with `filter`, only those of its kind and its status. */
	rules(filter: RuleFilter): Rule[] {
		return this.#rows(
			Rule,
			`SELECT ${RULE_COLUMNS} FROM rule WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY id`,
			filter.kind ?? null,
			filter.status ?? null,
		);
	}

	/** The rule `id`. An ID of no rule fails with `Unknown rule: <id>`. */
	rule(id: number): Rule {
		return this.findRule(id) ?? unknown("rule", id);
	}

	/** The rule `id`, or `undefined` when there is no such rule. */
	findRule(id: number): Rule | undefined {
		return this.#rows(Rule, `SELECT ${RULE_COLUMNS} FROM rule WHERE id = ?`, id)[0];
	}

	/** The rules that have the message `source` as their source, in ID order. */
	rulesWithSource(source: number): Rule[] {
		return this.#rows(Rule, `SELECT ${RULE_COLUMNS} FROM rule WHERE source = ? ORDER BY id`, source);
	}

	/** The held actions, in ID order. */
	held(): HeldAction[] {
		return this.#held(`SELECT ${HELD_COLUMNS} FROM held ORDER BY id`);
	}

	/** The held action `id`. An ID of no held action fails with `Unknown held action: <id>`. */
	heldAction(id: number): HeldAction {
		return this.findHeld(id) ?? unknown("held action", id);
	}

	/** The held action `id`, or `undefined` when there is no such action. */
	findHeld(id: number): HeldAction | undefined {
		return this.#held(`SELECT ${HELD_COLUMNS} FROM held WHERE id = ?`, id)[0];
	}

	/** The pending deliveries, oldest first. */
	deliveries(): PendingDelivery[] {
		return this.#rows(PendingDelivery, `SELECT "key", target, text, at FROM delivery ORDER BY at, rowid`);
	}

	/** The highest ID that a rule had, also a rule that is gone, or 0 when no rule was set. */
	lastRule(): number {
		const [row] = this.#rows(
			Type.Object({ seq: Type.Integer() }),
			"SELECT seq FROM sqlite_sequence WHERE name = 'rule'",
		);

		return row?.seq ?? 0;
	}

	#threads(sql: string, ...params: SQLInputValue[]): Thread[] {
		const persons = this.db.prepare("SELECT person FROM thread_person WHERE thread = ? ORDER BY rowid");

		return this.#rows(Type.Omit(Thread, ["persons"]), sql, ...params).map((thread) =>
			Value.Parse(Thread, { ...thread, persons: persons.all(thread.id).map((row) => row.person) }),
		);
	}

	/** The held actions of `sql` with `params`. */
	#held(sql: string, ...params: SQLInputValue[]): HeldAction[] {
		return this.#rows(HeldRow, sql, ...params).map(({ ranRequestId, ranAt, ...held }) =>
			Value.Parse(
				HeldAction,
				ranRequestId === undefined ? held : { ...held, ran: { requestId: ranRequestId, at: ranAt } },
			),
		);
	}

	/** The messages of `sql` with `params`, each parsed with `schema`. */
	#messages<T extends TSchema>(schema: T, sql: string, ...params: SQLInputValue[]) {
		return this.#rows(MessageRow, sql, ...params).map(({ changedAt, changedBy, ...message }) =>
			Value.Parse(
				schema,
				changedAt === undefined ? message : { ...message, changed: { at: changedAt, by: changedBy } },
			),
		);
	}

	/** The rows of `sql` with `params`, each without its NULL columns and parsed with `schema`. */
	#rows<T extends TSchema>(schema: T, sql: string, ...params: SQLInputValue[]) {
		return this.db
			.prepare(sql)
			.all(...params)
			.map((row) => Value.Parse(schema, withoutNulls(row)));
	}
}

/** The writes of one transaction of the store, which record what they change. */
export class StoreTx extends StoreReader {
	/** The objects that the writes changed, by `<table>:<id>`, in the order of their last change. */
	readonly #changed = new Map<string, { readonly table: ChangedTable; readonly id: number }>();

	/** One change for each object that the writes changed, with its state in the transaction, in order. */
	changes(): StoreChange[] {
		return [...this.#changed.values()].map(({ table, id }) => this.#change(table, id));
	}

	/** Adds the person `person`, with the next ID when it has none, and gives it. */
	addPerson(person: Omit<Person, "id"> & { id?: number }): Person {
		const id = this.#insert("INSERT INTO person (id, name) VALUES (?, ?)", person.id ?? null, person.name);
		this.#record("person", id);

		return { id, name: person.name };
	}

	/** Adds the thread `thread` with its persons, with the next ID when it has none, and gives it. */
	addThread(thread: Omit<Thread, "id"> & { id?: number }): Thread {
		const id = this.#insert(
			"INSERT INTO thread (id, topic, last) VALUES (?, ?, ?)",
			thread.id ?? null,
			thread.topic,
			thread.last ?? null,
		);

		for (const person of thread.persons) this.#join(id, person);
		this.#record("thread", id);

		return { ...thread, id, persons: [...thread.persons] };
	}

	/** Adds the person `person` to the thread `thread`, as its last person. */
	joinThread(thread: number, person: number): void {
		this.#join(thread, person);
		this.#record("thread", thread);
	}

	/** Sets the `last` of the thread `thread`, or removes it with `undefined`. */
	setLast(thread: number, last: number | undefined): void {
		this.db.prepare("UPDATE thread SET last = ? WHERE id = ?").run(last ?? null, thread);
		this.#record("thread", thread);
	}

	/** Adds the message `message`, with the next ID when it has none, and gives it. */
	addMessage(message: DistributiveOmit<FileMessage, "id"> & { id?: number }): FileMessage {
		const id = this.#insert(
			`INSERT INTO message (id, thread, person, direction, state, at, text, "by", changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			message.id ?? null,
			...messageValues(message),
		);

		this.#record("message", id);

		return { ...message, id };
	}

	/** Writes `message` over the message of its ID. */
	putMessage(message: FileMessage): void {
		this.db
			.prepare(
				`UPDATE message SET thread = ?, person = ?, direction = ?, state = ?, at = ?, text = ?, "by" = ?, changed_at = ?, changed_by = ? WHERE id = ?`,
			)
			.run(...messageValues(message), message.id);
		this.#record("message", message.id);
	}

	/** Removes the message `id`. */
	removeMessage(id: number): void {
		this.db.prepare("DELETE FROM message WHERE id = ?").run(id);
		this.#record("message", id);
	}

	/** Adds the rule `rule`, with the next ID when it has none, and gives it. */
	addRule(rule: Omit<Rule, "id"> & { id?: number }): Rule {
		const id = this.#insert(
			`INSERT INTO rule (id, name, kind, value, status, said_by, source, thread, replaces, at, "by") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			rule.id ?? null,
			...ruleValues(rule),
		);

		this.#record("rule", id);

		return { ...rule, id };
	}

	/** Writes `rule` over the rule of its ID. */
	putRule(rule: Rule): void {
		this.db
			.prepare(
				`UPDATE rule SET name = ?, kind = ?, value = ?, status = ?, said_by = ?, source = ?, thread = ?, replaces = ?, at = ?, "by" = ? WHERE id = ?`,
			)
			.run(...ruleValues(rule), rule.id);
		this.#record("rule", rule.id);
	}

	/** Removes the rule `id`. Its ID is never given again. */
	removeRule(id: number): void {
		this.db.prepare("DELETE FROM rule WHERE id = ?").run(id);
		this.#record("rule", id);
	}

	/** Adds the held action `held`, with the next ID when it has none, and gives it. */
	addHeld(held: DistributiveOmit<HeldAction, "id"> & { id?: number }): HeldAction {
		const id = this.#insert(
			`INSERT INTO held (id, request_id, agent, tool, command, rule, reason, state, ran_request_id, ran_at, at, "by") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			held.id ?? null,
			...heldValues(held),
		);

		this.#record("held", id);

		return this.heldAction(id);
	}

	/** Writes `held` over the held action of its ID. */
	putHeld(held: HeldAction): void {
		this.db
			.prepare(
				`UPDATE held SET request_id = ?, agent = ?, tool = ?, command = ?, rule = ?, reason = ?, state = ?, ran_request_id = ?, ran_at = ?, at = ?, "by" = ? WHERE id = ?`,
			)
			.run(...heldValues(held), held.id);
		this.#record("held", held.id);
	}

	/** Adds the pending delivery `delivery`. It is no change of the feed. */
	addDelivery(delivery: PendingDelivery): void {
		this.db
			.prepare(`INSERT INTO delivery ("key", target, text, at) VALUES (?, ?, ?, ?)`)
			.run(delivery.key, delivery.target, delivery.text, delivery.at);
	}

	/** Removes the pending delivery `key`, when there is one. It is no change of the feed. */
	removeDelivery(key: string): void {
		this.db.prepare(`DELETE FROM delivery WHERE "key" = ?`).run(key);
	}

	/** Makes `last` the highest ID that a rule had, when it is higher. */
	raiseLastRule(last: number): void {
		if (last <= this.lastRule()) return;
		this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'rule'").run();
		this.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('rule', ?)").run(last);
	}

	#insert(sql: string, ...params: SQLInputValue[]): number {
		return Number(this.db.prepare(sql).run(...params).lastInsertRowid);
	}

	#join(thread: number, person: number): void {
		this.db.prepare("INSERT INTO thread_person (thread, person) VALUES (?, ?)").run(thread, person);
	}

	/** Records a change of the object `id` of `table`, as its last change. */
	#record(table: ChangedTable, id: number): void {
		const key = `${table}:${id}`;
		this.#changed.delete(key);
		this.#changed.set(key, { table, id });
	}

	#change(table: ChangedTable, id: number): StoreChange {
		switch (table) {
			case "person":
				return { kind: table, value: this.person(id) };
			case "thread":
				return { kind: table, value: this.thread(id) };
			case "message": {
				const value = this.findMessage(id);

				return value === undefined ? { kind: "removed", table, id } : { kind: table, value };
			}

			case "rule": {
				const value = this.findRule(id);

				return value === undefined ? { kind: "removed", table, id } : { kind: table, value };
			}

			case "held":
				return { kind: table, value: this.heldAction(id) };
		}
	}
}

type ChangedTable = "person" | "thread" | "message" | "rule" | "held";

/** The store of a project, open on its file. */
export class ProjectStore extends StoreReader {
	readonly #listeners = new Set<StoreListener>();

	/**
	 * Opens `project.sqlite` in the directory `dir`, and creates its tables when they are not there. A lock that another
	 * process holds makes a write wait up to `timeout` ms: node:sqlite waits synchronously, so the wait stops the event
	 * loop.
	 */
	static open(dir: string, timeout: number): ProjectStore {
		const db = new DatabaseSync(join(dir, PROJECT_STORE_FILE), { timeout });

		try {
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA foreign_keys = ON");
			db.exec(SCHEMA);
		} catch (error) {
			db.close();
			throw error;
		}

		return new ProjectStore(db);
	}

	/**
	 * Runs `fn`, which must be synchronous, in one transaction, and gives its result. A throw of `fn` rolls the
	 * transaction back. After the commit, each listener gets the changes of the write, when there are any. A write
	 * inside a write fails.
	 */
	write<T>(fn: (tx: StoreTx) => T): T {
		const tx = new StoreTx(this.db);
		this.#begin();
		const [result, changes] = this.#end(() => [fn(tx), tx.changes()] as const);

		if (changes.length > 0) for (const listener of this.#listeners) listener(changes);

		return result;
	}

	/** Calls `listener` after each write that changes something, and gives the function that stops it. */
	subscribe(listener: StoreListener): () => void {
		this.#listeners.add(listener);

		return () => this.#listeners.delete(listener);
	}

	/**
	 * Writes the persons, the threads with their messages, the rules and the held actions of `file` into the store with
	 * the IDs of the file, then awaits `rest`, the write of the other lists, and commits only when it succeeds. A rule with a source
	 * gets the thread of its source message. The highest ID that a rule had becomes `lastRule` when it is higher. The
	 * load tells no listener.
	 */
	async load(file: StoreFile, rest: () => Promise<void>): Promise<void> {
		this.#begin();

		const [loaded] = await Promise.allSettled([this.#load(file, rest)]);

		this.#end(() => {
			if (loaded.status === "rejected") throw loaded.reason;
		});
	}

	/** Closes the store. A second close does nothing. */
	close(): void {
		this.#listeners.clear();

		if (this.db.isOpen) this.db.close();
	}

	async #load(file: StoreFile, rest: () => Promise<void>): Promise<void> {
		const tx = new StoreTx(this.db);
		const threads = new Map<number, number>();

		for (const person of file.persons) tx.addPerson(person);

		for (const { messages, ...thread } of file.threads) {
			tx.addThread(thread);

			for (const message of messages) {
				tx.addMessage(message);
				threads.set(message.id, thread.id);
			}
		}

		for (const { thread: _, ...rule } of file.rules) {
			const thread = rule.source === undefined ? undefined : threads.get(rule.source);
			tx.addRule(thread === undefined ? rule : { ...rule, thread });
		}

		for (const held of file.held) tx.addHeld(held);
		tx.raiseLastRule(file.lastRule);
		await rest();
	}

	#begin(): void {
		if (this.db.isTransaction) throw new Error("A write of the project store is in progress");
		this.db.exec("BEGIN IMMEDIATE");
	}

	/** Ends the transaction that `#begin` opened: commits when `fn` gives its result, and rolls back when it throws. */
	#end<T>(fn: () => T): T {
		try {
			const result = fn();
			this.db.exec("COMMIT");

			return result;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

/** Fails when `author` is a person that the store does not have. */
export function knownAuthor(reader: StoreReader, author: Author): void {
	if (author !== "user") reader.person(author);
}

/** `message` with no `changed`, as a reply gives it. */
export function replyMessage(message: FileMessage): Message {
	const { changed: _, ...reply } = message;

	return reply;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function messageValues(message: DistributiveOmit<FileMessage, "id">): SQLInputValue[] {
	const { thread, from, direction, state, at, text, by, changed } = message;

	return [thread, personOf(from), direction, state, at, text, by, changed?.at ?? null, changed?.by ?? null];
}

function ruleValues(rule: Omit<Rule, "id">): SQLInputValue[] {
	const { name, kind, value, status, saidBy, source, thread, replaces, at, by } = rule;

	return [name, kind, value, status, personOf(saidBy), source ?? null, thread ?? null, replaces ?? null, at, by];
}

function heldValues(held: DistributiveOmit<HeldAction, "id">): SQLInputValue[] {
	const { requestId, agent, tool, command, rule, reason, state, at, by } = held;
	const ran = held.state === "approved" ? held.ran : undefined;

	return [
		requestId,
		agent,
		tool,
		command,
		rule ?? null,
		reason,
		state,
		ran?.requestId ?? null,
		ran?.at ?? null,
		at,
		by,
	];
}

function personOf(author: Author): number | null {
	return author === "user" ? null : author;
}

function unknown(name: string, id: number): never {
	throw new Error(`Unknown ${name}: ${id}`);
}

function withoutNulls(row: Record<string, SQLOutputValue>): Record<string, SQLOutputValue> {
	return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
}
