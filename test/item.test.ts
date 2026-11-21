import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { Edge, type EdgeKind, ItemList, type ItemState, StagedItem } from "../src/protocol/item.ts";
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

async function add(title: string): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "add", caller: "cli", title }));
}

async function read(id: number): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "read", id }));
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

async function unlink(from: string, kind: EdgeKind, to: string): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "unlink", caller: "cli", from, kind, to }));
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
			StagedItem,
			await send({ type: "item", action: "add", caller: "cli", title: "Move the config", text: "Into *vite*." }),
		);

		const at = expect.any(Number);

		const first = {
			id: 1,
			title: "Move the config",
			text: "Into *vite*.",
			state: "open",
			edges: [],
			at,
			by: "cli",
			stage: "inbox",
			needsYou: false,
		};

		expect(added).toEqual(first);
		expect(await read(1)).toEqual(added);
		expect((await add("Second")).id).toBe(2);

		const done = await send({ type: "item", action: "set", caller: "cli2", id: 1, state: "done" });
		expect(done).toEqual({ ...first, state: "done", by: "cli2", stage: "done" });
		expect(await read(1)).toEqual(done);

		const renamed = await send({ type: "item", action: "set", caller: "cli3", id: 1, title: "Moved", text: "" });
		expect(renamed).toEqual({ ...first, title: "Moved", text: "", state: "done", by: "cli3", stage: "done" });
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
			[RUN, "needs", to],
			[to, "needs", COMMIT],
			["parley:a-b", "needs", to],
		];

		for (const [from, kind, end] of wrong) {
			const error = `An edge ${kind} cannot go from ${from} to ${end}`;
			await expect(link(from, kind, end)).rejects.toThrow(error);
			await expect(unlink(from, kind, end)).rejects.toThrow(error);
		}

		const bad = [
			[{ from: "agent:x", kind: "serves", to }, 'from: must match pattern "^item:[1-9][0-9]*$"'],
			[{ from: "run:2026", kind: "serves", to }, 'from: must match pattern "^item:[1-9][0-9]*$"'],
			[{ from: RUN, kind: "serves", to: "item:0" }, 'to: must match pattern "^item:[1-9][0-9]*$"'],
			[{ from: to, kind: "landed", to: "commit:3fa9c1e" }, 'to: must match pattern "^item:[1-9][0-9]*$"'],
			[{ from: "parley:Not-A-Slug", kind: "shapes", to }, 'from: must match pattern "^item:[1-9][0-9]*$"'],
			[{ from: RUN, kind: "blocks", to }, "kind: must be equal to one of the allowed values"],
		] as const;

		for (const [ends, rule] of bad) {
			for (const action of ["link", "unlink"]) {
				const line = JSON.parse(JSON.stringify({ type: "item", action, caller: "cli", ...ends }));
				await expect(send(line)).rejects.toThrow(`Invalid item request: ${rule}`);
			}
		}
	});

	it("refuses a serves edge from an agent: only the spawn of the agent writes it", async () => {
		const item = await add("Agent");
		const other = await add("Other");
		const refused = "Only the spawn of an agent writes its edge serves";

		const idle = await spawnWithId("item-session");
		await expect(link(`agent:${idle.id}`, "serves", `item:${item.id}`)).rejects.toThrow(refused);
		await expect(link("agent:999999", "serves", `item:${item.id}`)).rejects.toThrow(refused);

		const child = await spawnWithId("item-server", { serves: { item: item.id } });
		const [edge] = (await read(item.id)).edges;
		expect(edge).toMatchObject({ from: `agent:${child.id}`, kind: "serves", to: `item:${item.id}` });
		await expect(link(`agent:${child.id}`, "serves", `item:${other.id}`)).rejects.toThrow(refused);

		// The spawn wrote the edge: a link of the same edge gives it.
		expect(await link(`agent:${child.id}`, "serves", `item:${item.id}`)).toEqual(edge);
		expect((await read(item.id)).stage).toBe("building");
		expect(await read(other.id)).toEqual(other);
	});

	it("refuses a second item for a run, and takes one after the unlink of the first", async () => {
		const run = "run:20261120T143929-0000000c";
		const first = await add("First of the run");
		const second = await add("Second of the run");
		await link(run, "serves", `item:${first.id}`);

		await expect(link(run, "serves", `item:${second.id}`)).rejects.toThrow(
			`Run 20261120T143929-0000000c already serves item ${first.id}`,
		);

		expect(await read(second.id)).toEqual(second);

		await unlink(run, "serves", `item:${first.id}`);
		const moved = await link(run, "serves", `item:${second.id}`);
		expect((await read(second.id)).edges).toEqual([moved]);
	});

	it("links a parley that the store has, and refuses an unknown one", async () => {
		const item = await add("Parley");
		const to = `item:${item.id}`;
		await expect(link("parley:no-such-parley", "shapes", to)).rejects.toThrow("Unknown parley: no-such-parley");

		await framed("item-shaper");
		const edge = await link("parley:item-shaper", "shapes", to);
		expect(await read(item.id)).toEqual({ ...item, edges: [edge], stage: "shaping", needsYou: true });
	});

	it("refuses a serves or shapes edge to an item that is not open, and takes a landed edge", async () => {
		const item = await add("Closed");
		const to = `item:${item.id}`;
		const run = "run:20261120T143929-0000000d";
		const served = await link(run, "serves", to);
		await framed("closed-shaper");
		await send({ type: "item", action: "set", caller: "cli", id: item.id, state: "done" });

		await expect(link("run:20261120T143929-0000000a", "serves", to)).rejects.toThrow(
			`Item ${item.id} is done: an edge serves cannot go to it`,
		);

		await expect(link("parley:closed-shaper", "shapes", to)).rejects.toThrow(
			`Item ${item.id} is done: an edge shapes cannot go to it`,
		);

		// The edge that a resumed run sends again is still the stored one.
		expect(await link(run, "serves", to)).toEqual(served);
		const landed = await link(to, "landed", COMMIT);

		await send({ type: "item", action: "set", caller: "cli", id: item.id, state: "dropped" });
		await expect(link("run:20261120T143929-0000000e", "serves", to)).rejects.toThrow(
			`Item ${item.id} is dropped: an edge serves cannot go to it`,
		);

		expect((await read(item.id)).edges).toEqual([served, landed]);
	});

	it("removes an edge, and refuses an edge that the item does not have", async () => {
		const item = await add("Unlink");
		const to = `item:${item.id}`;
		const run = "run:20261120T143929-0000000f";
		await link(run, "serves", to);
		const landed = await link(to, "landed", COMMIT);

		expect(await unlink(run, "serves", to)).toEqual({ ...item, edges: [landed] });
		expect(await read(item.id)).toEqual({ ...item, edges: [landed] });

		await expect(unlink(run, "serves", to)).rejects.toThrow(`Item ${item.id} has no edge ${run} serves ${to}`);

		// A link after the unlink writes the edge again, after the edges that stayed.
		const again = await link(run, "serves", to);
		expect((await read(item.id)).edges).toEqual([landed, again]);
	});

	it("writes a needs edge on the item that needs, and a read of either item shows it", async () => {
		const a = await add("Needs");
		const b = await add("Needed");
		const c = await add("Needs too");
		const [from, to, third] = [`item:${a.id}`, `item:${b.id}`, `item:${c.id}`] as const;

		const edge = await link(from, "needs", to);
		expect(edge).toEqual({ from, kind: "needs", to, at: expect.any(Number), by: "cli" });
		expect(await link(from, "needs", to, "cli2")).toEqual(edge);
		const landed = await link(to, "landed", COMMIT);
		const other = await link(third, "needs", to);

		expect(await read(a.id)).toEqual({ ...a, edges: [edge] });
		// The edges of the item come first, then the needs edges that go to it, in the ID order of their items.
		expect(await read(b.id)).toEqual({ ...b, edges: [landed, edge, other] });
		expect(await read(c.id)).toEqual({ ...c, edges: [other] });

		// The other replies give the stored edges only.
		const listed = Value.Parse(ItemList, await send({ type: "item", action: "list" })).items;
		expect(listed.find((item) => item.id === b.id)?.edges).toEqual([landed]);

		const set = Value.Parse(
			StagedItem,
			await send({ type: "item", action: "set", caller: "cli", id: b.id, text: "x" }),
		);

		expect(set.edges).toEqual([landed]);
		expect(set.stage).toBe("inbox");

		expect(await unlink(from, "needs", to)).toEqual({ ...a, edges: [] });
		expect((await read(b.id)).edges).toEqual([landed, other]);
		await expect(unlink(from, "needs", to)).rejects.toThrow(`Item ${a.id} has no edge ${from} needs ${to}`);
	});

	it("refuses a needs edge to itself, from an unknown or closed item, to an unknown item, and a cycle", async () => {
		const a = await add("First need");
		const b = await add("Second need");
		const c = await add("Third need");
		const [first, second, third] = [`item:${a.id}`, `item:${b.id}`, `item:${c.id}`] as const;

		await expect(link(first, "needs", first)).rejects.toThrow(`An edge needs cannot go from ${first} to itself`);
		await expect(unlink(first, "needs", first)).rejects.toThrow(`An edge needs cannot go from ${first} to itself`);
		await expect(link("item:999", "needs", first)).rejects.toThrow("Unknown item: 999");
		await expect(link(first, "needs", "item:999")).rejects.toThrow("Unknown item: 999");

		const ab = await link(first, "needs", second);
		const bc = await link(second, "needs", third);

		const refused = (from: string, to: string) =>
			`Item ${to.slice(5)} already needs item ${from.slice(5)}: an edge needs cannot make a cycle`;

		await expect(link(second, "needs", first)).rejects.toThrow(refused(second, first));
		await expect(link(third, "needs", first)).rejects.toThrow(refused(third, first));

		// A refused link changes no item: each keeps its edges, its `at` and its `by`.
		expect(await read(a.id)).toEqual({ ...a, edges: [ab] });
		expect(await read(b.id)).toEqual({ ...b, edges: [bc, ab] });
		expect(await read(c.id)).toEqual({ ...c, edges: [bc] });

		// A closed item can be needed, but cannot need.
		await send({ type: "item", action: "set", caller: "cli", id: c.id, state: "done" });
		const done = await link(first, "needs", third);
		expect(done).toMatchObject({ from: first, kind: "needs", to: third });
		await expect(link(third, "needs", second)).rejects.toThrow(`Item ${c.id} is done: an edge needs cannot go from it`);
		// A stored edge is still the reply.
		await send({ type: "item", action: "set", caller: "cli", id: a.id, state: "dropped" });
		expect(await link(first, "needs", second)).toEqual(ab);
		await expect(link(first, "needs", `item:${(await add("Late")).id}`)).rejects.toThrow(
			`Item ${a.id} is dropped: an edge needs cannot go from it`,
		);
	});

	it("refuses a request whose fields are not valid", async () => {
		const bad = [
			[
				{ type: "item", action: "add", caller: "cli", title: " " },
				'Invalid item request: title: must match pattern "\\S"',
			],
			[{ type: "item", action: "add", title: "x" }, "Invalid item request: caller: required"],
			[
				{ type: "item", action: "set", caller: "cli", id: 1, title: "" },
				'Invalid item request: title: must match pattern "\\S"',
			],
			[
				{ type: "item", action: "set", caller: "cli", id: 1, state: "doing" },
				"Invalid item request: state: must be equal to one of the allowed values",
			],
			[{ type: "item", action: "set", caller: "cli", state: "done" }, "Invalid item request: id: required"],
			[
				{ type: "item", action: "list", state: "doing" },
				"Invalid item request: state: must be equal to one of the allowed values",
			],
			[{ type: "item", action: "read", id: 0 }, "Invalid item request: id: must be >= 1"],
			[
				{ type: "item", action: "link", from: RUN, kind: "serves", to: "item:1" },
				"Invalid item request: caller: required",
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
