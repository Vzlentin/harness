import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { Edge, type EdgeKind, ItemList, type ItemState, WorkItem } from "../src/protocol/item.ts";
import { Person, Thread } from "../src/protocol/project.ts";
import type { Request } from "../src/protocol/requests.ts";
import { framed, send, setUp, spawnWithId, startHost, tearDown } from "./helpers.ts";

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

const RUN = "run:20261120T143929-e08adff4";

const COMMIT = `commit:${"3fa9c1e".padEnd(40, "0")}`;

async function add(title: string): Promise<WorkItem> {
	return Value.Parse(WorkItem, await send({ type: "item", action: "add", caller: "cli", title }));
}

async function read(id: number): Promise<WorkItem> {
	return Value.Parse(WorkItem, await send({ type: "item", action: "read", id }));
}

/** The IDs of the items in the state `state`, or of the items that a list without a state gives. */
async function list(state?: ItemState): Promise<number[]> {
	const line: Extract<Request, { type: "item"; action: "list" }> = { type: "item", action: "list" };
	const reply = Value.Parse(ItemList, await send(state === undefined ? line : { ...line, state }));

	return reply.items.map((item) => item.id);
}

async function link(from: string, kind: EdgeKind, to: string, caller = "cli"): Promise<Edge> {
	return Value.Parse(Edge, await send({ type: "item", action: "link", caller, from, kind, to }));
}

async function unlink(from: string, kind: EdgeKind, to: string): Promise<WorkItem> {
	return Value.Parse(WorkItem, await send({ type: "item", action: "unlink", caller: "cli", from, kind, to }));
}

describe("the work items of the store", { timeout: 30_000 }, () => {
	it("knows no item before the first add", async () => {
		expect(await list()).toEqual([]);
		await expect(read(1)).rejects.toThrow("Unknown item: 1");
		await expect(send({ type: "item", action: "set", caller: "cli", id: 1, state: "done" })).rejects.toThrow(
			"Unknown item: 1",
		);
		await expect(link(RUN, "serves", "item:1")).rejects.toThrow("Unknown item: 1");
		await expect(unlink(RUN, "serves", "item:1")).rejects.toThrow("Unknown item: 1");
	});

	it("adds an open item with the next ID and no edge, and changes only the fields that a set gives", async () => {
		const added = Value.Parse(
			WorkItem,
			await send({ type: "item", action: "add", caller: "cli", title: "Move the config", text: "Into *vite*." }),
		);

		const at = expect.any(Number);
		const first = { id: 1, title: "Move the config", text: "Into *vite*.", state: "open", edges: [], at, by: "cli" };
		expect(added).toEqual(first);
		expect(await read(1)).toEqual(added);
		expect((await add("Second")).id).toBe(2);

		const done = await send({ type: "item", action: "set", caller: "cli2", id: 1, state: "done" });
		expect(done).toEqual({ ...first, state: "done", by: "cli2" });
		expect(await read(1)).toEqual(done);

		const renamed = await send({ type: "item", action: "set", caller: "cli3", id: 1, title: "Moved", text: "" });
		expect(renamed).toEqual({ ...first, title: "Moved", text: "", state: "done", by: "cli3" });
		expect(await list()).toEqual([2]);
		expect(await list("done")).toEqual([1]);
		expect(await list("dropped")).toEqual([]);

		const reopened = await send({ type: "item", action: "set", caller: "cli", id: 1, state: "open" });
		expect(reopened).toEqual({ ...first, title: "Moved", text: "", by: "cli" });
		expect(await read(1)).toEqual(reopened);
		expect(await list()).toEqual([1, 2]);
		expect(await list("done")).toEqual([]);

		await expect(read(3)).rejects.toThrow("Unknown item: 3");
		await expect(send({ type: "item", action: "set", caller: "cli", id: 3, title: "x" })).rejects.toThrow(
			"Unknown item: 3",
		);
	});

	it("lists the items in the order of their IDs", async () => {
		const added: number[] = [];

		for (let n = 0; n < 10; n++) added.push((await add(`Item ${n}`)).id);
		expect(added).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(await list()).toEqual([1, 2, ...added]);
	});

	it("writes an edge once, and gives the stored edge again for the same ends and kind", async () => {
		const item = await add("Serve it");
		const to = `item:${item.id}`;
		const edge = await link(RUN, "serves", to);
		expect(edge).toEqual({ from: RUN, kind: "serves", to, at: expect.any(Number), by: "cli" });

		// A resumed run sends its link again, with its own caller.
		expect(await link(RUN, "serves", to, "cli2")).toEqual(edge);
		expect(await read(item.id)).toEqual({ ...item, edges: [edge] });

		const landed = await link(to, "landed", COMMIT);
		expect((await read(item.id)).edges).toEqual([edge, landed]);
	});

	it("refuses ends that the kind of the edge does not take", async () => {
		const to = `item:${(await add("Ends")).id}`;

		const wrong: [from: string, kind: EdgeKind, to: string][] = [
			[COMMIT, "serves", to],
			[to, "serves", to],
			[RUN, "serves", COMMIT],
			["agent:5", "shapes", to],
			[RUN, "shapes", to],
			[to, "landed", to],
			[RUN, "landed", COMMIT],
			["parley:a-b", "landed", COMMIT],
		];

		for (const [from, kind, end] of wrong) {
			const error = `An edge ${kind} cannot go from ${from} to ${end}`;
			await expect(link(from, kind, end)).rejects.toThrow(error);
			await expect(unlink(from, kind, end)).rejects.toThrow(error);
		}

		const bad = [
			[{ from: "agent:x", kind: "serves", to }, "from"],
			[{ from: "run:2026", kind: "serves", to }, "from"],
			[{ from: RUN, kind: "serves", to: "item:0" }, "to"],
			[{ from: to, kind: "landed", to: "commit:3fa9c1e" }, "to"],
			[{ from: "parley:Not-A-Slug", kind: "shapes", to }, "from"],
			[{ from: RUN, kind: "blocks", to }, "kind"],
		] as const;

		for (const [ends, field] of bad) {
			for (const action of ["link", "unlink"]) {
				const line = JSON.parse(JSON.stringify({ type: "item", action, caller: "cli", ...ends }));
				await expect(send(line)).rejects.toThrow(`Invalid item request: ${field} is not valid`);
			}
		}
	});

	it("links an agent that the children library opened, and refuses an unknown one", async () => {
		const item = await add("Agent");
		const to = `item:${item.id}`;
		const person = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }));
		const thread = Value.Parse(Thread, await send({ type: "thread", action: "add", topic: "T", persons: [person.id] }));
		await expect(link("agent:999999", "serves", to)).rejects.toThrow("Unknown conversation: 999999");
		await expect(link(`agent:${thread.id}`, "serves", to)).rejects.toThrow(`Unknown conversation: ${thread.id}`);

		const child = await spawnWithId("item-session");
		const edge = await link(`agent:${child.id}`, "serves", to);
		expect(await read(item.id)).toEqual({ ...item, edges: [edge] });
	});

	it("links a parley that the store has, and refuses an unknown one", async () => {
		const item = await add("Parley");
		const to = `item:${item.id}`;
		await expect(link("parley:no-such-parley", "shapes", to)).rejects.toThrow("Unknown parley: no-such-parley");

		await framed("item-shaper");
		const edge = await link("parley:item-shaper", "shapes", to);
		expect(await read(item.id)).toEqual({ ...item, edges: [edge] });
	});

	it("refuses a serves or shapes edge to an item that is not open, and takes a landed edge", async () => {
		const item = await add("Closed");
		const to = `item:${item.id}`;
		const served = await link(RUN, "serves", to);
		await framed("closed-shaper");
		await send({ type: "item", action: "set", caller: "cli", id: item.id, state: "done" });

		await expect(link("run:20261120T143929-0000000a", "serves", to)).rejects.toThrow(
			`Item ${item.id} is done: an edge serves cannot go to it`,
		);

		await expect(link("parley:closed-shaper", "shapes", to)).rejects.toThrow(
			`Item ${item.id} is done: an edge shapes cannot go to it`,
		);

		// The edge that a resumed run sends again is still the stored one.
		expect(await link(RUN, "serves", to)).toEqual(served);
		const landed = await link(to, "landed", COMMIT);

		await send({ type: "item", action: "set", caller: "cli", id: item.id, state: "dropped" });
		await expect(link(RUN.replace("e08adff4", "e08adff5"), "serves", to)).rejects.toThrow(
			`Item ${item.id} is dropped: an edge serves cannot go to it`,
		);

		expect((await read(item.id)).edges).toEqual([served, landed]);
	});

	it("removes an edge, and refuses an edge that the item does not have", async () => {
		const item = await add("Unlink");
		const to = `item:${item.id}`;
		await link(RUN, "serves", to);
		const landed = await link(to, "landed", COMMIT);

		expect(await unlink(RUN, "serves", to)).toEqual({ ...item, edges: [landed] });
		expect(await read(item.id)).toEqual({ ...item, edges: [landed] });

		await expect(unlink(RUN, "serves", to)).rejects.toThrow(`Item ${item.id} has no edge ${RUN} serves ${to}`);

		// A link after the unlink writes the edge again, after the edges that stayed.
		const again = await link(RUN, "serves", to);
		expect((await read(item.id)).edges).toEqual([landed, again]);
	});

	it("refuses a request whose fields are not valid", async () => {
		const bad = [
			[{ type: "item", action: "add", caller: "cli", title: " " }, "Invalid item request: title is not valid"],
			[{ type: "item", action: "add", title: "x" }, "Invalid item request: caller is required"],
			[{ type: "item", action: "set", caller: "cli", id: 1, title: "" }, "Invalid item request: title is not valid"],
			[
				{ type: "item", action: "set", caller: "cli", id: 1, state: "doing" },
				"Invalid item request: state is not valid",
			],
			[{ type: "item", action: "set", caller: "cli", state: "done" }, "Invalid item request: id is required"],
			[{ type: "item", action: "list", state: "doing" }, "Invalid item request: state is not valid"],
			[{ type: "item", action: "read", id: 0 }, "Invalid item request: id is not valid"],
			[
				{ type: "item", action: "link", from: RUN, kind: "serves", to: "item:1" },
				"Invalid item request: caller is required",
			],
		] as const;

		for (const [line, error] of bad) await expect(send(JSON.parse(JSON.stringify(line)))).rejects.toThrow(error);
	});

	it("keeps the items and the counter after a restart", async () => {
		const open = await list();
		const ids = [...open, ...(await list("done")), ...(await list("dropped"))];
		const first = await read(1);
		await host?.close();
		host = await startHost();

		expect(await list()).toEqual(open);
		expect(await read(1)).toEqual(first);
		expect((await add("After the restart")).id).toBe(Math.max(...ids) + 1);
	});
});
