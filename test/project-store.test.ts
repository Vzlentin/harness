import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ProjectStore, type StoreChange } from "../src/projects/project-store.ts";
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

	it("tells one change for each object of a write, with its committed state", () => {
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
			{ kind: "person", value: { id: 1, name: "Ann" } },
			{ kind: "person", value: { id: 2, name: "Bob" } },
			expect.objectContaining({ kind: "message", value: expect.objectContaining({ id: 1, state: "sent" }) }),
			{ kind: "thread", value: { id: 1, topic: "launch", persons: [1, 2], last: 1 } },
		]);
	});

	it("tells the ID of a removed rule", () => {
		const rule = store.write((tx) =>
			tx.addRule({ name: "tone", kind: "conduct", value: "short", status: "decided", saidBy: "user", at: 1, by: "a" }),
		);

		store.write((tx) => tx.removeRule(rule.id));

		expect(writes[1]).toEqual([{ kind: "removed", table: "rule", id: rule.id }]);
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

	it("fails a write inside a write", () => {
		expect(() => store.write(() => store.write(() => undefined))).toThrow(
			"A write of the project store is in progress",
		);
		expect(writes).toEqual([]);
	});
});
