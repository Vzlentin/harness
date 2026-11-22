/**
 * `project.sqlite`: the persons, the threads with their persons, the messages, the rules, the held actions, the
 * parleys, and the work items with their edges of the project, and the pending deliveries, as plain tables beside
 * `durable.sqlite`. The host is the only writer: a write is one synchronous transaction, and the store tells its
 * listeners the table and the ID of each object that it changed, after the commit, or after the commit of
 * `durable.sqlite` that the write is part of. An async transaction, such as the import of a store file, tells no
 * listener. Each table gives the next ID of its list and never gives an ID again. The edges give the items of each end,
 * and the `needs` edges that go to an item.
 */
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { Edge, type EdgeInput, type EdgeItem, edgeItem, type ItemState, WorkItem } from "../protocol/item.ts";
import {
	type Author,
	HeldAction,
	HeldFields,
	Message,
	Parley,
	ParleyFields,
	Person,
	Rule,
	type RuleFilter,
	Thread,
} from "../protocol/project.ts";
import { FileMessage, OutFileMessage } from "../protocol/store-file.ts";

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

const PARLEY_COLUMNS = `id, slug, title, goal, evidence, design_sense, status, at, "by"`;

const ITEM_COLUMNS = `id, title, text, state, at, "by"`;

const EDGE_COLUMNS = `"from", kind, "to", at, "by"`;

/** A parley row, with its evidence as JSON text. */
const ParleyRow = Type.Object({
	...ParleyFields,
	design_sense: Type.Optional(Type.String()),
	evidence: Type.Optional(Type.String()),
	status: Type.String(),
});

/** An item row, without its edges. */
const ItemRow = Type.Omit(WorkItem, ["edges"]);

/** A parley as a write gives it, with the next ID when it has none. */
type NewParley = DistributiveOmit<Parley, "id"> & { id?: number };

/** The fields of an item as a write gives them, with the next ID when it has none. */
type NewItem = Omit<WorkItem, "id" | "edges"> & { id?: number };

/** A held action row, with the call that an approved action ran for in two columns. */
const HeldRow = Type.Object({
	...HeldFields,
	state: Type.String(),
	ranRequestId: Type.Optional(Type.String()),
	ranAt: Type.Optional(HeldFields.at),
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

/** A table whose objects a write tells its listeners. */
export type ChangedTable = "person" | "thread" | "message" | "rule" | "held" | "parley" | "item";

/**
 * A change of a write: the table and the ID of an object that it added, changed or removed. A change of an edge is a
 * change of its item.
 */
export type StoreChange = { readonly table: ChangedTable; readonly id: number };

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
		return (
			this.#messages(FileMessage, `SELECT ${MESSAGE_COLUMNS} FROM message WHERE id = ?`, id)[0] ??
			unknown("message", id)
		);
	}

	/** The messages out, in ID order: with `thread`, only those of that thread. */
	outMessages(thread?: number): OutFileMessage[] {
		return this.#messages(
			OutFileMessage,
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
		return this.#sequence("rule") ?? 0;
	}

	/** The parleys, in ID order. */
	parleys(): Parley[] {
		return this.#parleys(`SELECT ${PARLEY_COLUMNS} FROM parley ORDER BY id`);
	}

	/** The parley `id`. An ID of no parley fails with `Unknown parley: <id>`. */
	parley(id: number): Parley {
		return this.findParley(id) ?? unknown("parley", id);
	}

	/** The parley `id`, or `undefined` when there is no such parley. */
	findParley(id: number): Parley | undefined {
		return this.#parleys(`SELECT ${PARLEY_COLUMNS} FROM parley WHERE id = ?`, id)[0];
	}

	/** The parley `slug`. A slug of no parley fails with `Unknown parley: <slug>`. */
	parleyBySlug(slug: string): Parley {
		return this.findParleyBySlug(slug) ?? unknown("parley", slug);
	}

	/** The parley `slug`, or `undefined` when there is no such parley. */
	findParleyBySlug(slug: string): Parley | undefined {
		return this.#parleys(`SELECT ${PARLEY_COLUMNS} FROM parley WHERE slug = ?`, slug)[0];
	}

	/** The items, in ID order, each with its own edges: with `state`, only those in that state. */
	items(state?: ItemState): WorkItem[] {
		return this.#items(`SELECT ${ITEM_COLUMNS} FROM item WHERE (?1 IS NULL OR state = ?1) ORDER BY id`, state ?? null);
	}

	/**
	 * The item `id`, in any state, with its own edges in the order of their writes: the edges from the item, and the
	 * edges to it that are not `needs`. An ID of no item fails with `Unknown item: <id>`.
	 */
	item(id: number): WorkItem {
		return this.findItem(id) ?? unknown("item", id);
	}

	/** The item `id` with its own edges, or `undefined` when there is no such item. */
	findItem(id: number): WorkItem | undefined {
		return this.#items(`SELECT ${ITEM_COLUMNS} FROM item WHERE id = ?`, id)[0];
	}

	/** The `needs` edges that go to the item `id` from other items, in the ID order of those items. */
	incomingNeeds(id: number): Edge[] {
		return this.#rows(
			Edge,
			`SELECT ${EDGE_COLUMNS} FROM edge WHERE kind = 'needs' AND "to" = ? ORDER BY CAST(substr("from", 6) AS INTEGER), id`,
			`item:${id}`,
		);
	}

	/** The IDs of the items whose edges come from `end`, a `run:`, a `parley:` or an `agent:` reference, in ID order. */
	itemsFrom(end: string): number[] {
		return this.#rows(
			Type.Object({ id: Type.Integer() }),
			`SELECT DISTINCT CAST(substr("to", 6) AS INTEGER) AS id FROM edge WHERE "from" = ? AND "to" LIKE 'item:%' ORDER BY id`,
			end,
		).map((row) => row.id);
	}

	/** The highest ID that an item had, or `undefined` when the store has no counter of the IDs of items. */
	lastItem(): number | undefined {
		return this.#sequence("item");
	}

	/** The last ID that the table `table` gave, or `undefined` when it has none. */
	#sequence(table: string): number | undefined {
		const [row] = this.#rows(
			Type.Object({ seq: Type.Integer() }),
			"SELECT seq FROM sqlite_sequence WHERE name = ?",
			table,
		);

		return row?.seq;
	}

	/** The parleys of `sql` with `params`. */
	#parleys(sql: string, ...params: SQLInputValue[]): Parley[] {
		return this.#rows(ParleyRow, sql, ...params).map(({ evidence, ...parley }) =>
			Value.Parse(Parley, evidence === undefined ? parley : { ...parley, evidence: JSON.parse(evidence) }),
		);
	}

	/** The items of `sql` with `params`, each with its own edges. */
	#items(sql: string, ...params: SQLInputValue[]): WorkItem[] {
		return this.#rows(ItemRow, sql, ...params).map((item) => {
			const ref = `item:${item.id}`;

			const edges = this.#rows(
				Edge,
				`SELECT ${EDGE_COLUMNS} FROM edge WHERE "from" = ?1 OR ("to" = ?1 AND kind <> 'needs') ORDER BY id`,
				ref,
			);

			return { ...item, edges };
		});
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
	readonly #changed = new Map<string, StoreChange>();

	/** One change for each object that the writes changed, in the order of their last change. */
	changes(): StoreChange[] {
		return [...this.#changed.values()];
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
		if (last > this.lastRule()) this.#setSequence("rule", last);
	}

	/** Adds the parley `parley`, with the next ID when it has none, and gives it. */
	addParley(parley: NewParley): Parley {
		const id = this.#insert(
			`INSERT INTO parley (id, slug, title, goal, evidence, design_sense, status, at, "by") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			parley.id ?? null,
			...parleyValues(parley),
		);

		this.#record("parley", id);

		return this.parley(id);
	}

	/** Writes `parley` over the parley of its ID. */
	putParley(parley: Parley): void {
		this.db
			.prepare(
				`UPDATE parley SET slug = ?, title = ?, goal = ?, evidence = ?, design_sense = ?, status = ?, at = ?, "by" = ? WHERE id = ?`,
			)
			.run(...parleyValues(parley), parley.id);
		this.#record("parley", parley.id);
	}

	/** Adds the item `item` with no edge, with the next ID when it has none, and gives it. */
	addItem(item: NewItem): WorkItem {
		const id = this.#insert(
			`INSERT INTO item (id, title, text, state, at, "by") VALUES (?, ?, ?, ?, ?, ?)`,
			item.id ?? null,
			...itemValues(item),
		);

		this.#record("item", id);

		return this.item(id);
	}

	/** Writes the fields of `item` over the item of its ID. Its edges do not change. */
	putItem(item: Omit<WorkItem, "edges">): void {
		this.db
			.prepare(`UPDATE item SET title = ?, text = ?, state = ?, at = ?, "by" = ? WHERE id = ?`)
			.run(...itemValues(item), item.id);
		this.#record("item", item.id);
	}

	/** Adds the edge `edge` as the last edge of its item. */
	addEdge(edge: Edge): void {
		const { from, kind, to, at, by } = edge;
		this.db
			.prepare(`INSERT INTO edge ("from", kind, "to", at, "by") VALUES (?, ?, ?, ?, ?)`)
			.run(from, kind, to, at, by);
		this.#record("item", edgeEnds(edge).id);
	}

	/** Removes the edges with the ends and the kind of `edge`. */
	removeEdge(edge: EdgeInput): void {
		this.db.prepare(`DELETE FROM edge WHERE "from" = ? AND kind = ? AND "to" = ?`).run(edge.from, edge.kind, edge.to);
		this.#record("item", edgeEnds(edge).id);
	}

	/**
	 * Writes `items`, each with its edges, with their IDs, and makes `last` the highest ID that an item had, when it is
	 * higher. The counter of the IDs of items exists after it, also with no item.
	 */
	loadItems(items: readonly WorkItem[], last: number): void {
		for (const { edges, ...item } of items) {
			this.addItem(item);

			for (const edge of edges) this.addEdge(edge);
		}

		const stored = this.lastItem();

		if (stored === undefined || last > stored) this.#setSequence("item", last);
	}

	#setSequence(table: string, last: number): void {
		this.db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
		this.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, last);
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
}

/** The store of a project, open on its file. */
export class ProjectStore extends StoreReader {
	readonly #listeners = new Set<StoreListener>();
	/** How many `writeAcross` calls run now. */
	#across = 0;
	/** The changes of the writes that commit while a `writeAcross` runs, which its listeners get after it. */
	#deferred: StoreChange[] = [];

	/**
	 * Opens the file `file`, default `project.sqlite`, in the directory `dir`, and creates its tables when they are not
	 * there. A lock that another process holds makes a write wait up to `timeout` ms: node:sqlite waits synchronously, so
	 * the wait stops the event loop.
	 */
	static open(dir: string, timeout: number, file = PROJECT_STORE_FILE): ProjectStore {
		const db = new DatabaseSync(join(dir, file), { timeout });

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

		if (this.#across > 0) this.#deferred.push(...changes);
		else this.#tell(changes);

		return result;
	}

	/**
	 * Runs `outer`, such as a commit of `durable.sqlite` whose callback writes the store, and gives its result. Each
	 * write commits at once, but the listeners get the changes of the writes only once `outer` settles, and no
	 * `writeAcross` runs: a listener then reads the two stores with all of their writes.
	 */
	async writeAcross<T>(outer: () => Promise<T>): Promise<T> {
		this.#across += 1;

		try {
			return await outer();
		} finally {
			this.#across -= 1;

			if (this.#across === 0) {
				const changes = this.#deferred;
				this.#deferred = [];
				this.#tell(changes);
			}
		}
	}

	/** Calls `listener` after each write that changes something, and gives the function that stops it. */
	subscribe(listener: StoreListener): () => void {
		this.#listeners.add(listener);

		return () => this.#listeners.delete(listener);
	}

	/**
	 * Runs `fn` in one transaction, and gives its result. It commits once `fn` settles, and rolls back when `fn` fails. It
	 * tells no listener. A write while it runs fails.
	 */
	async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
		const tx = new StoreTx(this.db);
		this.#begin();

		try {
			const result = await fn(tx);
			this.db.exec("COMMIT");

			return result;
		} catch (error) {
			this.#rollback();
			throw error;
		}
	}

	/** Closes the store. A second close does nothing. */
	close(): void {
		this.#listeners.clear();

		if (this.db.isOpen) this.db.close();
	}

	/** Gives `changes` to each listener, when there are any. */
	#tell(changes: readonly StoreChange[]): void {
		if (changes.length > 0) for (const listener of this.#listeners) listener(changes);
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
			this.#rollback();
			throw error;
		}
	}

	#rollback(): void {
		if (this.db.isTransaction) this.db.exec("ROLLBACK");
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

function parleyValues(parley: NewParley): SQLInputValue[] {
	const { slug, title, goal, evidence, design_sense, status, at, by } = parley;

	return [
		slug,
		title,
		goal,
		evidence === undefined ? null : JSON.stringify(evidence),
		design_sense ?? null,
		status,
		at,
		by,
	];
}

function itemValues(item: NewItem): SQLInputValue[] {
	return [item.title, item.text ?? null, item.state, item.at, item.by];
}

/** The ID of the item that stores `edge`, and the reference at its other end. Ends that its kind does not take fail. */
export function edgeEnds(edge: EdgeInput): EdgeItem {
	const ends = edgeItem(edge);

	if (ends === undefined) throw new Error(`An edge ${edge.kind} cannot go from ${edge.from} to ${edge.to}`);

	return ends;
}

function personOf(author: Author): number | null {
	return author === "user" ? null : author;
}

function unknown(name: string, id: number | string): never {
	throw new Error(`Unknown ${name}: ${id}`);
}

function withoutNulls(row: Record<string, SQLOutputValue>): Record<string, SQLOutputValue> {
	return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
}
