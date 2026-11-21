import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { GateReply } from "../src/protocol/gate.ts";
import { type EdgeKind, ItemList, type ItemState, StagedItem } from "../src/protocol/item.ts";
import {
	answer,
	called,
	framed,
	gates,
	root,
	round,
	send,
	setUp,
	spawnWithId,
	startHost,
	tearDown,
	until,
	untilContract,
	untilState,
} from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	setEntry("fixture", join(FIXTURE, "ask.ts"));
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

async function add(title: string): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "add", caller: "cli", title }));
}

/** The stage and the mark of the item `id`, as `item read` gives them. */
async function markOf(id: number): Promise<Pick<StagedItem, "stage" | "needsYou">> {
	const { stage, needsYou } = Value.Parse(StagedItem, await send({ type: "item", action: "read", id }));

	return { stage, needsYou };
}

async function link(from: string, kind: EdgeKind, to: string): Promise<void> {
	await send({ type: "item", action: "link", caller: "cli", from, kind, to });
}

async function set(id: number, state: ItemState): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "set", caller: "cli", id, state }));
}

/**
 * Starts the first task of the run `runId` with `labels`, whose child waits until the test opens the gate of `prompt`.
 */
async function startRun(runId: string, prompt: string, labels: string[]): Promise<PromiseWithResolvers<void>> {
	const gate = Promise.withResolvers<void>();
	gates.set(prompt, gate);
	await send({ type: "start", kind: "fixture.ask", key: `wf:${runId}#1`, input: { cwd: root, prompt }, labels });
	await until(() => called(prompt) === 1);

	return gate;
}

/** Writes one open ask with no parley, whose asker is `asker`, and gives its ID. */
async function askOf(asker: string, title: string): Promise<number> {
	const [ask] = (await round(asker, undefined, [{ title }])).asks;

	if (ask === undefined) throw new Error("no ask");

	return ask.id;
}

describe("the stage and the mark of the work items", { timeout: 60_000 }, () => {
	it("gives the first stage whose check holds: building, then shaping, then ready, then inbox", async () => {
		const item = await add("Stages");
		expect(item).toMatchObject({ stage: "inbox", needsYou: false });

		const { call, readBack } = await framed("stage-shaper");
		await link("parley:stage-shaper", "shapes", `item:${item.id}`);
		expect(await markOf(item.id)).toEqual({ stage: "shaping", needsYou: true });

		await answer([
			{ id: call, answer: "a" },
			{ id: readBack, answer: "ok" },
		]);
		await untilContract("stage-shaper");

		expect(await markOf(item.id)).toEqual({ stage: "ready", needsYou: false });

		const child = await spawnWithId("stage-session", { serves: { item: item.id } });
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: false });

		const listed = Value.Parse(ItemList, await send({ type: "item", action: "list" }));
		expect(listed.items.find((found) => found.id === item.id)).toMatchObject({ stage: "building" });

		await send({ type: "stop", caller: "stage-session", handle: child.handle });
		await untilState(child.handle, "ended");
		expect(await markOf(item.id)).toEqual({ stage: "ready", needsYou: false });
	});

	it("gives done and dropped from the state, whatever the edges", async () => {
		const item = await add("Closed");
		await spawnWithId("closed-session", { serves: { item: item.id } });
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: false });

		// A live agent does not hold back done: the agent can close its own item.
		expect(await set(item.id, "done")).toMatchObject({ state: "done", stage: "done" });
		expect(await set(item.id, "dropped")).toMatchObject({ state: "dropped", stage: "dropped" });

		const listed = Value.Parse(ItemList, await send({ type: "item", action: "list", state: "dropped" }));
		expect(listed.items.find((found) => found.id === item.id)).toMatchObject({ stage: "dropped" });
	});

	it("keeps an item in building while its run is live or waits for an input, and refuses done until then", async () => {
		const runId = "20261121T090000-a0000001";
		const otherRun = "20261121T090000-a0000002";
		const item = await add("Run");
		const dropped = await add("Dropped while the run is live");
		await link(`run:${runId}`, "serves", `item:${item.id}`);
		await link(`run:${otherRun}`, "serves", `item:${dropped.id}`);
		// The host keeps no run by ID: a run with no task and no ask is not live.
		expect(await markOf(item.id)).toEqual({ stage: "inbox", needsYou: false });

		const gate = await startRun(runId, "Stage run", [`item:${item.id}`]);
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: false });

		const refused = `Item ${item.id} cannot be done: run ${runId} serves it and is live`;
		await expect(set(item.id, "done")).rejects.toThrow(refused);
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: false });
		const otherAsk = await askOf(`workflows:${otherRun}`, "Which base");
		expect(await markOf(dropped.id)).toEqual({ stage: "building", needsYou: true });
		expect(await set(dropped.id, "dropped")).toMatchObject({ stage: "dropped" });
		await send({ type: "ask", action: "drop", caller: "cli", id: otherAsk });

		gate.resolve();
		expect(await send({ type: "wait-task", key: `wf:${runId}#1` })).toMatchObject({ status: "terminal" });
		expect(await markOf(item.id)).toEqual({ stage: "inbox", needsYou: false });

		// A run that waits for an input has a terminal task: its open ask keeps it live.
		const ask = await askOf(`workflows:${runId}`, "Which branch");
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: true });
		await expect(set(item.id, "done")).rejects.toThrow(refused);

		await send({ type: "ask", action: "drop", caller: "cli", id: ask });
		expect(await markOf(item.id)).toEqual({ stage: "inbox", needsYou: false });

		const again = await askOf(`workflows:${runId}`, "Which remote");
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: true });
		await expect(set(item.id, "done")).rejects.toThrow(refused);

		await answer([{ id: again, answer: "own", label: "origin" }]);
		expect(await markOf(item.id)).toEqual({ stage: "inbox", needsYou: false });
		expect(await set(item.id, "done")).toMatchObject({ state: "done", stage: "done" });
	});

	it("refuses done only for the runs of the tasks with the label of the item, not for its serves edges", async () => {
		const runId = "20261121T090000-a0000003";
		const item = await add("Edge only");
		await link(`run:${runId}`, "serves", `item:${item.id}`);
		const ask = await askOf(`workflows:${runId}`, "Which tag");

		expect(await set(item.id, "done")).toMatchObject({ state: "done", stage: "done" });
		await send({ type: "ask", action: "drop", caller: "cli", id: ask });
	});

	it("needs the user for an open ask or a held action of an agent that serves the item", async () => {
		const item = await add("Agent asks");
		const child = await spawnWithId("asking-session", { serves: { item: item.id } });
		const other = await spawnWithId("other-session");

		const elsewhere = await askOf(other.id, "Not about this item");
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: false });

		const ask = await askOf(child.id, "Which name");
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: true });

		await send({ type: "ask", action: "drop", caller: "cli", id: ask });
		await send({ type: "ask", action: "drop", caller: "cli", id: elsewhere });
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: false });

		const gated = Value.Parse(
			GateReply,
			await send({
				type: "gate",
				requestId: "stage-1",
				caller: child.id,
				tool: "bash",
				arguments: { command: "harness rule decide 1" },
				messages: [],
			}),
		);

		if (gated.runs) throw new Error("the gate did not hold the call");
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: true });

		await send({ type: "held", action: "drop", caller: "user", id: gated.held.id });
		expect(await markOf(item.id)).toEqual({ stage: "building", needsYou: false });
	});
});
