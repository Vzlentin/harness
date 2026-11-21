import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { ItemList, StagedItem } from "../src/protocol/item.ts";
import { AskList, AskWrite, Parley, ParleyAsks } from "../src/protocol/project.ts";
import { answer, framed, OPTIONS, round, send, setUp, startHost, tearDown } from "./helpers.ts";

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

async function add(title: string): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "add", caller: "cli", title }));
}

async function read(id: number): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "read", id }));
}

async function items(): Promise<StagedItem[]> {
	return Value.Parse(ItemList, await send({ type: "item", action: "list" })).items;
}

async function set(id: number, state: "open" | "done" | "dropped", caller = "cli"): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "set", caller, id, state }));
}

async function parleyOf(slug: string): Promise<Parley> {
	return Value.Parse(ParleyAsks, await send({ type: "parley", action: "read", slug })).parley;
}

/** Makes the parley `slug` a contract that shapes a new open item for each of `titles`, and gives their IDs. */
async function contractOf(slug: string, ...titles: string[]): Promise<number[]> {
	const ids: number[] = [];

	for (const title of titles) ids.push((await add(title)).id);
	const { call, readBack } = await framed(slug);

	for (const id of ids) {
		await send({
			type: "item",
			action: "link",
			caller: "cli",
			from: `parley:${slug}`,
			kind: "shapes",
			to: `item:${id}`,
		});
	}

	await answer([
		{ id: call, answer: "a" },
		{ id: readBack, answer: "ok" },
	]);

	return ids;
}

async function openAsks(): Promise<AskList> {
	return Value.Parse(AskList, await send({ type: "ask", action: "list" }));
}

/** A round as `pi-1` for the new parley `slug`, with one call, that shapes the item `item`. */
async function shapingRound(slug: string, item: number): Promise<AskWrite> {
	const parley = { slug, title: `Shape ${slug}`, goal: "Pick." };
	const asks = [{ title: "Which", kind: "your call" as const, options: OPTIONS }];

	return Value.Parse(AskWrite, await send({ type: "ask", action: "round", caller: "pi-1", parley, item, asks }));
}

describe("the shapes edge of a round and of a contract", { timeout: 30_000 }, () => {
	it("writes the edge of a round with item once, and the item is shaping and needs the user", async () => {
		const item = await add("Shaped by a round");
		await shapingRound("round-shapes", item.id);
		await shapingRound("round-shapes", item.id);

		const linked = await read(item.id);
		expect(linked.edges).toEqual([
			{ from: "parley:round-shapes", kind: "shapes", to: `item:${item.id}`, at: expect.any(Number), by: "pi-1" },
		]);
		expect(linked).toMatchObject({ stage: "shaping", needsYou: true });
	});

	it("refuses a round with an unknown item, a done item, or item without parley, and writes nothing", async () => {
		const done = await add("Done before the round");
		await send({ type: "item", action: "set", caller: "cli", id: done.id, state: "done" });
		const before = await openAsks();

		await expect(shapingRound("unknown-item", 999)).rejects.toThrow("Unknown item: 999");
		await expect(shapingRound("done-item", done.id)).rejects.toThrow(
			`Item ${done.id} is done: an edge shapes cannot go to it`,
		);
		const bare = { type: "ask", action: "round", caller: "pi-1", item: done.id, asks: [{ title: "Bare" }] };
		await expect(send(JSON.parse(JSON.stringify(bare)))).rejects.toThrow("Invalid ask request: parley: required");

		expect(await openAsks()).toEqual(before);
		expect((await read(done.id)).edges).toEqual([]);
	});

	it("gives a contract that shapes no item a new item, with the title of the parley and the edge", async () => {
		const count = (await items()).length;
		const { call, readBack } = await framed("contract-new-item");
		await answer([
			{ id: call, answer: "a" },
			{ id: readBack, answer: "ok" },
		]);

		const after = await items();
		expect(after).toHaveLength(count + 1);
		const created = after.at(-1);
		expect(created).toMatchObject({
			title: "Where asks live",
			state: "open",
			by: "user",
			edges: [{ from: "parley:contract-new-item", kind: "shapes", to: `item:${created?.id}`, by: "user" }],
			stage: "ready",
		});
		expect(created?.text).toBeUndefined();
	});

	it("adds no item for a contract that shapes one, and the shaped item becomes ready", async () => {
		const item = await add("Shaped before the contract");
		const { call, readBack } = await framed("contract-shaped");
		await send({
			type: "item",
			action: "link",
			caller: "cli",
			from: "parley:contract-shaped",
			kind: "shapes",
			to: `item:${item.id}`,
		});
		const count = (await items()).length;

		await answer([
			{ id: call, answer: "a" },
			{ id: readBack, answer: "ok" },
		]);

		expect(await items()).toHaveLength(count);
		expect(await read(item.id)).toMatchObject({ stage: "ready" });
	});

	it("adds no item when the contract is refused", async () => {
		const written = await round("pi-1", { slug: "contract-refused", title: "No sense", goal: "Fail." }, [
			{ title: "These are the terms" },
		]);

		const readBack = written.parleys[0]?.asks[0]?.id;

		if (readBack === undefined) throw new Error("no read-back");
		const last = (await items()).at(-1)?.id ?? 0;

		await expect(answer([{ id: readBack, answer: "ok" }])).rejects.toThrow(
			"Parley contract-refused cannot be a contract: design_sense is not set",
		);
		expect((await add("After the refusal")).id).toBe(last + 1);
	});
});

describe("the items of a contract end it", { timeout: 30_000 }, () => {
	it("ends the contract as done when its last open item closes, with the caller of that change", async () => {
		const [first = 0, second = 0] = await contractOf("ends-with-items", "First part", "Second part");

		await set(first, "done");
		expect(await parleyOf("ends-with-items")).toMatchObject({ status: "contract" });

		await set(second, "dropped", "pi-2");
		expect(await parleyOf("ends-with-items")).toMatchObject({ status: "done", by: "pi-2" });
	});

	it("ends the contract as dropped when no item that it shapes is done", async () => {
		const [first = 0, second = 0] = await contractOf("all-dropped", "First drop", "Second drop");

		await set(first, "dropped");
		await set(second, "dropped");
		expect(await parleyOf("all-dropped")).toMatchObject({ status: "dropped", by: "cli" });
	});

	it("does not reopen the contract when its item goes back to open", async () => {
		const [item = 0] = await contractOf("stays-ended", "Reopened");

		await set(item, "done");
		await set(item, "open");
		expect(await parleyOf("stays-ended")).toMatchObject({ status: "done" });
	});

	it("does not count an item whose shapes edge was unlinked", async () => {
		const [kept = 0, unlinked = 0] = await contractOf("unlinked-item", "Kept", "Unlinked");
		const edge = { from: "parley:unlinked-item", kind: "shapes", to: `item:${unlinked}` } as const;
		await send({ type: "item", action: "unlink", caller: "cli", ...edge });

		await set(kept, "done");
		expect(await parleyOf("unlinked-item")).toMatchObject({ status: "done" });
		expect(await read(unlinked)).toMatchObject({ state: "open" });
	});

	it("refuses parley end while the contract shapes open items, and changes nothing", async () => {
		const [first = 0, second = 0] = await contractOf("end-refused", "Open one", "Open two");
		const end = { type: "parley", action: "end", caller: "pi-1", slug: "end-refused", status: "done" } as const;
		const before = await parleyOf("end-refused");

		await expect(send(end)).rejects.toThrow(
			`Parley end-refused shapes open items ${first}, ${second}: close them, and the contract ends`,
		);
		await set(first, "done");
		await expect(send(end)).rejects.toThrow(
			`Parley end-refused shapes open items ${second}: close them, and the contract ends`,
		);
		expect(await parleyOf("end-refused")).toEqual(before);
	});
});
