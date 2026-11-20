import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { type ItemState, StagedItem } from "../src/protocol/item.ts";
import type { ProjectEvent } from "../src/protocol/project-watch.ts";
import { MAIN_PROJECT } from "../src/protocol/projects.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
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
	untilState,
	watchProject,
} from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

let host: Host | undefined;

type Watch = Awaited<ReturnType<typeof watchProject>>;

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

async function set(id: number, state: ItemState): Promise<StagedItem> {
	return Value.Parse(StagedItem, await send({ type: "item", action: "set", caller: "cli", id, state }));
}

async function link(from: string, id: number): Promise<void> {
	const kind = from.startsWith("parley:") ? "shapes" : "serves";
	await send({ type: "item", action: "link", caller: "cli", from, kind, to: `item:${id}` });
}

/** Writes one open ask with no parley, whose asker is `asker`, and gives its ID. */
async function askOf(asker: string, title: string): Promise<number> {
	const [ask] = (await round(asker, undefined, [{ title }])).asks;

	if (ask === undefined) throw new Error("no ask");

	return ask.id;
}

/** Waits for the first event of `watch` from index `from` on that has the item `id`, and gives that item. */
async function itemEvent(watch: Watch, from: number, id: number): Promise<{ event: ProjectEvent; item: StagedItem }> {
	let found: { event: ProjectEvent; item: StagedItem } | undefined;

	await until(() => {
		for (const event of watch.events.slice(from)) {
			const item = event.items.find((staged) => staged.id === id);

			if (item !== undefined) {
				found = { event, item };

				return true;
			}
		}

		return false;
	});

	if (found === undefined) throw new Error(`no event with item ${id}`);

	return found;
}

/** The items of the events of `watch` from index `from` on. */
function itemsSince(watch: Watch, from: number): StagedItem[] {
	return watch.events.slice(from).flatMap((event) => event.items);
}

describe("the work items in watch-project", { timeout: 60_000 }, () => {
	it("gives the open items in the reply, and an event for each add, set and link, with a done item once", async () => {
		const open = await add("Open in the reply");
		const done = await add("Done before the watch");
		await set(done.id, "done");
		const watch = await watchProject(MAIN_PROJECT);

		try {
			expect(watch.state.items.find((item) => item.id === open.id)).toEqual(open);
			expect(watch.state.items.some((item) => item.id === done.id)).toBe(false);
			expect(watch.state.items.every((item) => item.state === "open")).toBe(true);

			let from = watch.events.length;
			const added = await add("Added during the watch");
			expect((await itemEvent(watch, from, added.id)).item).toEqual(added);

			from = watch.events.length;

			const renamed = Value.Parse(
				StagedItem,
				await send({ type: "item", action: "set", caller: "cli", id: added.id, title: "Renamed" }),
			);

			expect((await itemEvent(watch, from, added.id)).item).toEqual(renamed);

			from = watch.events.length;
			await link("run:20261121T100000-b0000001", added.id);
			const linked = await itemEvent(watch, from, added.id);
			expect(linked.item.edges).toMatchObject([{ from: "run:20261121T100000-b0000001", kind: "serves" }]);
			expect(linked.item.stage).toBe("inbox");

			from = watch.events.length;
			await set(added.id, "done");
			const closed = await itemEvent(watch, from, added.id);
			expect(closed.item).toMatchObject({ state: "done", stage: "done" });
			expect(closed.event.removed.items).toEqual([]);

			// The done item comes no more, and goes in no removed list.
			from = watch.events.length;
			const later = await add("After the done item");
			const after = await itemEvent(watch, from, later.id);
			expect(after.event.items.map((item) => item.id)).toEqual([later.id]);
			expect(after.event.removed.items).toEqual([]);

			// A commit that changes nothing of the watch sends no event.
			from = watch.events.length;
			await send({ type: "todo", caller: "cli", action: "add", handle: AGENT_HANDLE, text: "Not an item" });
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(watch.events.slice(from)).toEqual([]);

			const again = await watchProject(MAIN_PROJECT);
			again.socket.destroy();
			expect(again.state.items.some((item) => item.id === added.id)).toBe(false);
			expect(again.state.items.find((item) => item.id === later.id)).toEqual(later);
		} finally {
			watch.socket.destroy();
		}
	});

	it("sends the item of a child that ends, out of building, and no item of another end", async () => {
		const served = await add("Served by the child that ends");
		const other = await add("Served by a child that stays");
		const child = await spawnWithId("ending-session", { serves: { item: served.id } });
		const stays = await spawnWithId("staying-session", { serves: { item: other.id } });
		const bystander = await spawnWithId("bystander-session");
		const watch = await watchProject(MAIN_PROJECT);

		try {
			expect(watch.state.items.find((item) => item.id === served.id)).toMatchObject({ stage: "building" });
			expect(watch.state.items.find((item) => item.id === other.id)).toMatchObject({ stage: "building" });

			// A child that serves no item and ends gives no event.
			let from = watch.events.length;
			await send({ type: "stop", caller: "bystander-session", handle: bystander.handle });
			await untilState(bystander.handle, "ended");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(itemsSince(watch, from)).toEqual([]);

			from = watch.events.length;
			await send({ type: "stop", caller: "ending-session", handle: child.handle });
			const ended = await itemEvent(watch, from, served.id);
			expect(ended.item).toMatchObject({ state: "open", stage: "inbox" });
			expect(ended.event.items.map((item) => item.id)).toEqual([served.id]);
			expect(itemsSince(watch, from).some((item) => item.id === other.id)).toBe(false);
		} finally {
			watch.socket.destroy();
			await send({ type: "stop", caller: "staying-session", handle: stays.handle });
		}
	});

	it("moves the item of a parley from shaping to ready when the parley becomes a contract", async () => {
		const item = await add("Shaped in the watch");
		const watch = await watchProject(MAIN_PROJECT);

		try {
			let from = watch.events.length;
			const { call, readBack } = await framed("watched-contract");
			await link("parley:watched-contract", item.id);
			expect((await itemEvent(watch, from, item.id)).item).toMatchObject({ stage: "shaping", needsYou: true });

			from = watch.events.length;
			await answer([
				{ id: call, answer: "a" },
				{ id: readBack, answer: "ok" },
			]);
			await until(() => itemsSince(watch, from).some((found) => found.id === item.id && found.stage === "ready"));
			expect(
				itemsSince(watch, from)
					.filter((found) => found.id === item.id)
					.at(-1),
			).toMatchObject({
				stage: "ready",
				needsYou: false,
			});
		} finally {
			watch.socket.destroy();
		}
	});

	it("sets needsYou for an ask of an agent that serves the item, and clears it with the answer", async () => {
		const item = await add("Agent asks in the watch");
		const child = await spawnWithId("watched-asker", { serves: { item: item.id } });
		const watch = await watchProject(MAIN_PROJECT);

		try {
			expect(watch.state.items.find((found) => found.id === item.id)).toMatchObject({ needsYou: false });

			let from = watch.events.length;
			const ask = await askOf(child.id, "Which name");
			expect((await itemEvent(watch, from, item.id)).item).toMatchObject({ stage: "building", needsYou: true });

			from = watch.events.length;
			await answer([{ id: ask, answer: "own", label: "Sam" }]);
			expect((await itemEvent(watch, from, item.id)).item).toMatchObject({ needsYou: false });
		} finally {
			watch.socket.destroy();
			await send({ type: "stop", caller: "watched-asker", handle: child.handle });
		}
	});

	it("keeps a run in building while its ask is open after its task completes, and moves it out with the answer", async () => {
		const runId = "20261121T110000-c0000001";
		const item = await add("Run in the watch");
		await link(`run:${runId}`, item.id);
		const watch = await watchProject(MAIN_PROJECT);

		try {
			let from = watch.events.length;
			const gate = Promise.withResolvers<void>();
			gates.set("Watched run", gate);
			await send({
				type: "start",
				kind: "fixture.ask",
				key: `wf:${runId}#1`,
				input: { cwd: root, prompt: "Watched run" },
			});
			await until(() => called("Watched run") === 1);
			expect((await itemEvent(watch, from, item.id)).item).toMatchObject({ stage: "building", needsYou: false });

			from = watch.events.length;
			const ask = await askOf(`workflows:${runId}`, "Which branch");
			expect((await itemEvent(watch, from, item.id)).item).toMatchObject({ stage: "building", needsYou: true });

			from = watch.events.length;
			gate.resolve();
			expect(await send({ type: "wait-task", key: `wf:${runId}#1` })).toMatchObject({ status: "terminal" });
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(itemsSince(watch, from).filter((found) => found.id === item.id)).toEqual([]);

			from = watch.events.length;
			await answer([{ id: ask, answer: "own", label: "main" }]);
			expect((await itemEvent(watch, from, item.id)).item).toMatchObject({ stage: "inbox", needsYou: false });
		} finally {
			watch.socket.destroy();
		}
	});
});
