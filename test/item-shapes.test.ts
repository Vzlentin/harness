import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { ItemList, StagedItem } from "../src/protocol/item.ts";
import { AskList, AskWrite } from "../src/protocol/project.ts";
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
