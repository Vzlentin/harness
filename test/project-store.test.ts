import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ProjectStore, type StoreChange } from "../src/projects/project-store.ts";
import { approveHeld, holdAction, runApproved } from "../src/projects/project.ts";
import { root, setUp, tearDown } from "./helpers.ts";

describe("project store", () => {
	let store: ProjectStore;
	let writes: (readonly StoreChange[])[];

	beforeEach(async () => {
		await setUp();
		store = ProjectStore.open(await mkdtemp(join(root, "project-store-")), 0);
		writes = [];
		store.subscribe((changes) => writes.push(changes));
	});

	afterEach(async () => {
		store.close();
		await tearDown();
	});

	it("tells the table and the ID of each object of a write, in the order of their last change", () => {
		store.write((tx) => {
			const ann = tx.addPerson({ name: "Ann" });
			const bob = tx.addPerson({ name: "Bob" });
			const thread = tx.addThread({ topic: "launch", persons: [ann.id, bob.id] });

			tx.addMessage({
				thread: thread.id,
				from: "user",
				direction: "out",
				state: "draft",
				at: 1,
				text: "hello",
				by: "agent",
				changed: { at: 1, by: "agent" },
			});

			for (const out of tx.outMessages(thread.id))
				tx.putMessage({ ...out, state: "sent", changed: { at: 2, by: "a" } });
			tx.setLast(thread.id, 1);
		});

		expect(writes).toHaveLength(1);
		expect(writes[0]).toEqual([
			{ table: "person", id: 1 },
			{ table: "person", id: 2 },
			{ table: "message", id: 1 },
			{ table: "thread", id: 1 },
		]);
	});

	it("tells the ID of a removed rule", () => {
		const rule = store.write((tx) =>
			tx.addRule({ name: "tone", kind: "conduct", value: "short", status: "decided", saidBy: "user", at: 1, by: "a" }),
		);

		store.write((tx) => tx.removeRule(rule.id));

		expect(writes[1]).toEqual([{ table: "rule", id: rule.id }]);
	});

	it("rolls a failed write back and tells no listener", () => {
		expect(() =>
			store.write((tx) => {
				tx.addPerson({ name: "Ann" });
				throw new Error("stop");
			}),
		).toThrow("stop");

		expect(store.persons()).toEqual([]);
		expect(writes).toEqual([]);
	});

	it("commits a transaction once it settles, rolls a failed one back, and tells no listener", async () => {
		await store.transaction(async (tx) => {
			tx.addPerson({ name: "Ann" });
			await Promise.resolve();
			expect(() => store.write(() => undefined)).toThrow("A write of the project store is in progress");
		});

		await expect(
			store.transaction(async (tx) => {
				tx.addPerson({ name: "Bob" });
				await Promise.resolve();
				throw new Error("stop");
			}),
		).rejects.toThrow("stop");

		expect(store.persons()).toEqual([{ id: 1, name: "Ann" }]);
		expect(writes).toEqual([]);
	});

	it("fails a write inside a write", () => {
		expect(() => store.write(() => store.write(() => undefined))).toThrow(
			"A write of the project store is in progress",
		);
		expect(writes).toEqual([]);
	});

	it("adds the delivery of an approve only when another caller than the agent approves, and removes it when the action runs", () => {
		const call = { agent: "khan", tool: "bash", command: "git push", reason: "No go." };
		const own = store.write((tx) => holdAction(tx, { ...call, requestId: "call-1" }));
		const other = store.write((tx) => holdAction(tx, { ...call, requestId: "call-2" }));

		store.write((tx) => approveHeld(tx, own.id, "khan"));
		expect(store.deliveries()).toEqual([]);

		store.write((tx) => approveHeld(tx, other.id, "user"));
		expect(store.deliveries()).toEqual([
			{
				key: `approve:${other.id}`,
				target: "khan",
				text: `The user approved held action ${other.id}: git push. Call it again: it runs one time with no question.`,
				at: expect.any(Number),
			},
		]);
		expect(writes.at(-1)).toEqual([{ table: "held", id: other.id }]);

		// The approve of the agent runs first; the other one runs with the next call, and its delivery goes.
		store.write((tx) => runApproved(tx, { ...call, requestId: "call-3" }));
		expect(store.deliveries()).toHaveLength(1);
		const ran = store.write((tx) => runApproved(tx, { ...call, requestId: "call-4" }));
		expect(ran).toMatchObject({ id: other.id, ran: { requestId: "call-4" } });
		expect(store.findHeld(other.id)).toEqual(ran);
		expect(store.deliveries()).toEqual([]);
	});

	it("tells the parleys and the items that a write changes, and an edge as a change of its item", () => {
		const parley = store.write((tx) =>
			tx.addParley({ slug: "place", title: "T", goal: "G", evidence: ["e"], status: "open", at: 1, by: "a" }),
		);

		const item = store.write((tx) => tx.addItem({ title: "Work", state: "open", at: 1, by: "a" }));
		const edge = { from: "parley:place", kind: "shapes", to: `item:${item.id}`, at: 2, by: "a" } as const;

		store.write((tx) => {
			tx.addEdge(edge);
			tx.putParley({ ...parley, status: "contract", design_sense: "D", at: 3 });
		});

		expect(writes).toEqual([
			[{ table: "parley", id: parley.id }],
			[{ table: "item", id: item.id }],
			[
				{ table: "item", id: item.id },
				{ table: "parley", id: parley.id },
			],
		]);
		expect(store.item(item.id).edges).toEqual([edge]);
		expect(store.parleyBySlug("place")).toMatchObject({ id: parley.id, status: "contract" });
		expect(() => store.parley(9)).toThrow("Unknown parley: 9");
		expect(() => store.parleyBySlug("none")).toThrow("Unknown parley: none");
		expect(() => store.item(9)).toThrow("Unknown item: 9");
	});

	it("gives the items of an end and the needs edges that go to an item in the ID order of the items", () => {
		const run = "run:20260101T000000-abcdef01";

		store.write((tx) => {
			for (const title of ["a", "b", "c"]) tx.addItem({ title, state: "open", at: 1, by: "a" });
			tx.addEdge({ from: "item:3", kind: "needs", to: "item:1", at: 1, by: "a" });
			tx.addEdge({ from: "item:2", kind: "needs", to: "item:1", at: 2, by: "a" });
			tx.addEdge({ from: run, kind: "serves", to: "item:3", at: 3, by: "a" });
			tx.addEdge({ from: run, kind: "serves", to: "item:2", at: 4, by: "a" });
		});

		expect(store.itemsFrom(run)).toEqual([2, 3]);
		expect(store.incomingNeeds(1).map((edge) => edge.from)).toEqual(["item:2", "item:3"]);
		expect(store.item(1).edges).toEqual([]);
		expect(store.item(3).edges.map((edge) => edge.kind)).toEqual(["needs", "serves"]);
	});

	it("has no counter of the IDs of items until a load of items writes it, also at 0", () => {
		expect(store.lastItem()).toBeUndefined();

		store.write((tx) => tx.loadItems([], 0));
		expect(store.lastItem()).toBe(0);

		store.write((tx) => tx.loadItems([], 5));
		expect(store.write((tx) => tx.addItem({ title: "Next", state: "open", at: 1, by: "a" })).id).toBe(6);
	});

	it("tells the writes of a writeAcross only once it settles, also when it fails", async () => {
		const outer = Promise.withResolvers<void>();

		const across = store.writeAcross(async () => {
			store.write((tx) => tx.addPerson({ name: "Ann" }));
			await outer.promise;
		});

		expect(store.persons()).toHaveLength(1);
		expect(writes).toEqual([]);
		outer.resolve();
		await across;
		expect(writes).toEqual([[{ table: "person", id: 1 }]]);

		await expect(
			store.writeAcross(async () => {
				store.write((tx) => tx.addPerson({ name: "Bob" }));
				throw new Error("stop");
			}),
		).rejects.toThrow("stop");
		expect(writes.at(-1)).toEqual([{ table: "person", id: 2 }]);
	});
});
