import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type TaskId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MAX_DELTAS } from "../src/children/checkpoint.ts";
import { addPerson, readPersons } from "../src/host/project.ts";
import { addTodo, readTodos, setTodo } from "../src/host/todo.ts";
import { PERSONS_KIND, type PersonList } from "../src/protocol/project.ts";
import { TASK_TODO_LIST_KIND } from "../src/protocol/todo.ts";
import { openDurableHost, root, setUp, tearDown } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

/** How many commits change the list of a test. It is many times `MAX_DELTAS`, so the list stores a base many times. */
const CHANGES = 3000;

/** How many deltas the older store of a test has: more than a host with a rule lets a list have. */
const OLD_DELTAS = 500;

/** Counts the revisions that the store at a path keeps for the documents of a kind. */
type Count = (kind: string) => number;

/** A path for a new store in a new directory of the root of the tests. */
async function newStore(): Promise<string> {
	return join(await mkdtemp(join(root, "chain-")), "store.sqlite");
}

/**
 * Runs `use` with a count of the rows that the file at `path` has in `document_revisions` for the documents of a kind.
 * It reads with its own connection, so it counts what the storage wrote, not what the harness holds in memory.
 */
async function counting<T>(path: string, use: (count: Count) => Promise<T>): Promise<T> {
	const database = new DatabaseSync(path, { readOnly: true });

	try {
		const rows = database.prepare(
			`SELECT count(*) AS rows FROM document_revisions
			WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)`,
		);

		// pi-durable stores the kind of a document as JSON.
		return await use((kind) => Value.Parse(Type.Object({ rows: Type.Integer() }), rows.get(JSON.stringify(kind))).rows);
	} finally {
		database.close();
	}
}

beforeAll(setUp);

afterAll(tearDown);

describe("the revisions of a document of the store", () => {
	it("stay at most MAX_DELTAS + 1 for a list of the store that changes many times", async () => {
		const path = await newStore();
		const harness = await openDurableHost(path, []);

		try {
			await harness.root(context);

			const most = await counting(path, async (count) => {
				let seen = 0;

				for (let index = 0; index < CHANGES; index++) {
					await harness.commit((tx) => addPerson(tx, { name: `Person ${index}` }), context);
					seen = Math.max(seen, count(PERSONS_KIND));
				}

				return seen;
			});

			// The list keeps its deltas up to the bound: it does not store its whole value at each change.
			expect(most).toBe(MAX_DELTAS + 1);
		} finally {
			await harness.close(context);
		}

		const opened = await openDurableHost(path, []);

		try {
			const { persons } = await readPersons(opened, context);
			expect(persons).toHaveLength(CHANGES);
			expect(persons.at(-1)).toEqual({ id: CHANGES, name: `Person ${CHANGES - 1}` });
		} finally {
			await opened.close(context);
		}
	});

	it("is one revision for the list of a task, after each change", async () => {
		const path = await newStore();
		const harness = await openDurableHost(path, []);
		// SAFETY: the list of a task is a document of the session by task ID, and needs no task with this ID.
		const owner = { kind: "task", id: 7 as TaskId } as const;

		try {
			await harness.root(context);
			const todo = await harness.commit((tx) => addTodo(tx, owner, "Write the test"), context);

			const most = await counting(path, async (count) => {
				let seen = 0;

				for (let index = 0; index < MAX_DELTAS * 2; index++) {
					const state = index % 2 === 0 ? "doing" : "open";
					await harness.commit((tx) => setTodo(tx, owner, { id: todo.id, state, text: `Text ${index}` }), context);
					seen = Math.max(seen, count(TASK_TODO_LIST_KIND));
				}

				return seen;
			});

			expect(most).toBe(1);
			expect(await readTodos(harness, owner, context)).toEqual({
				todos: [{ id: todo.id, text: `Text ${MAX_DELTAS * 2 - 1}`, state: "open" }],
			});
		} finally {
			await harness.close(context);
		}
	});

	it("drop to one at the next change of a list that an older host never checkpointed", async () => {
		const path = await newStore();

		// The list of the persons as a host before the checkpoint rule defined it: the same kind, version and scope.
		const OldPersons = defineDoc<PersonList>({
			kind: PERSONS_KIND,
			version: 1,
			scope: "session",
			checkpointWhen: () => false,
			initial: () => ({ persons: [] }),
		});

		const old = await openDurableHost(path, []);

		try {
			await old.root(context);

			for (let index = 0; index <= OLD_DELTAS; index++) {
				await old.commit(async (tx) => {
					const list = await tx.doc(OldPersons);
					list.persons.push({ id: index + 1, name: `Person ${index}` });
				}, context);
			}
		} finally {
			await old.close(context);
		}

		await counting(path, async (count) => {
			expect(count(PERSONS_KIND)).toBe(OLD_DELTAS + 1);
			const harness = await openDurableHost(path, []);

			try {
				// A read changes nothing: the store needs no migration, and compacts at the next change of the list.
				expect((await readPersons(harness, context)).persons).toHaveLength(OLD_DELTAS + 1);
				expect(count(PERSONS_KIND)).toBe(OLD_DELTAS + 1);

				const added = await harness.commit((tx) => addPerson(tx, { name: "New" }), context);
				expect(added).toEqual({ id: OLD_DELTAS + 2, name: "New" });
				expect(count(PERSONS_KIND)).toBe(1);
			} finally {
				await harness.close(context);
			}
		});

		const opened = await openDurableHost(path, []);

		try {
			const { persons } = await readPersons(opened, context);
			expect(persons).toHaveLength(OLD_DELTAS + 2);
			expect(persons.at(0)).toEqual({ id: 1, name: "Person 0" });
			expect(persons.at(-1)).toEqual({ id: OLD_DELTAS + 2, name: "New" });
		} finally {
			await opened.close(context);
		}
	});
});
