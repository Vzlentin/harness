import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type CommitChange,
	type ConversationId,
	type Harness,
	ROOT_CONVERSATION_ID,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { EntryOptions } from "../src/host/entries.ts";
import type { Host } from "../src/host/run.ts";
import { type Ask, AskList } from "../src/protocol/asks.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { askGroup } from "../src/protocol/requests.ts";
import { root, send, setUp, startHost, tearDown, until } from "./helpers.ts";

/** What the entry of the tests shares with them, through `globalThis`, since it runs in this process. */
type Shared = {
	handles?: Pick<EntryOptions, "asks" | "todos"> & {
		/** The place of the host, whose store is the harness of the host. */
		readonly place: { readonly store: Pick<Harness, "commit" | "snapshot"> };
	};
	/** What the host gives the open of the entry. */
	opened?: { readonly harness: Pick<Harness, "observeCommits">; readonly storage: Pick<Storage, "scanDocuments"> };
};

const shared: Shared = {};

Object.assign(globalThis, { harnessStores: shared });

/** The entry of the tests: it keeps its handles, and what its open gets. */
const STORES_ENTRY = `export default function storesEntry(handles) {
	globalThis.harnessStores.handles = handles;
	return {
		extensions: [],
		open: async (opened) => {
			globalThis.harnessStores.opened = opened;
		},
		close: async () => {},
	};
}
`;

// SAFETY: the store has no conversation 999, so a read of its list finds none, and `changed` only compares the ID.
const OTHER = 999 as ConversationId;

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	const module = join(root, "stores-entry.mjs");
	await writeFile(module, STORES_ENTRY);
	setEntry("stores", module);
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

function handles(): NonNullable<Shared["handles"]> {
	if (shared.handles === undefined) throw new Error("no handles");

	return shared.handles;
}

function opened(): NonNullable<Shared["opened"]> {
	if (shared.opened === undefined) throw new Error("not opened");

	return shared.opened;
}

/** Runs `write` in one commit of the store of the host, and gives its result. */
function commit<T>(write: (tx: Tx) => Promise<T>): Promise<T> {
	return handles().place.store.commit(write, BACKGROUND_CONTEXT);
}

/** The ask `id`, as the `read` of the asks handle gives it. */
async function readAsk(id: number): Promise<Ask> {
	const { asks } = await handles().asks.read(handles().place.store, BACKGROUND_CONTEXT);
	const ask = asks.find((found) => found.id === id);

	if (ask === undefined) throw new Error(`no ask ${id}`);

	return ask;
}

describe("the asks handle of an entry", { timeout: 30_000 }, () => {
	it("adds asks that the commit and the ask requests see", async () => {
		const { asks } = handles();

		const [added, seen] = await commit(async (tx) => {
			const [ask] = await asks.add(tx, [{ input: { title: "Store A" } }], "pi-stores", 1);

			return [ask, (await asks.inCommit(tx)).map((each) => each.id)] as const;
		});

		if (added === undefined) throw new Error("no ask");
		expect(added).toMatchObject({ title: "Store A", state: "open", asker: "pi-stores" });
		expect(seen).toContain(added.id);
		const listed = Value.Parse(AskList, await send({ type: "ask", action: "list" }));
		expect(listed.asks.map((ask) => ask.id)).toContain(added.id);
	});

	it("answers, notes, drops and takes asks in the commits of the entry", async () => {
		const { asks } = handles();

		const [answered, dropped, taken] = await commit(async (tx) => {
			const added = await asks.add(
				tx,
				[{ input: { title: "Answer me" } }, { input: { title: "Drop me" } }, { input: { title: "Take me" } }],
				"pi-stores",
				2,
			);

			return added.map((ask) => ask.id);
		});

		if (answered === undefined || dropped === undefined || taken === undefined) throw new Error("no asks");

		await commit((tx) =>
			asks.answer(
				tx,
				[{ id: answered, answer: "own", label: "Mine" }],
				new Set(),
				"user",
				{ kind: "user" },
				ROOT_CONVERSATION_ID,
				(group) => group.map(askGroup),
			),
		);

		await commit((tx) => asks.note(tx, answered, "note-1", "pi-stores"));
		await commit((tx) => asks.drop(tx, dropped, "pi-stores"));
		await commit((tx) => asks.take(tx, [taken], "pi-taker"));

		expect(await readAsk(answered)).toMatchObject({ state: "answered", answer: "own", label: "Mine", note: "note-1" });
		expect(await readAsk(dropped)).toMatchObject({ state: "dropped", by: "pi-stores" });
		expect(await readAsk(taken)).toMatchObject({ state: "open", asker: "pi-taker" });
		await expect(commit((tx) => asks.drop(tx, dropped, "pi-stores"))).rejects.toThrow(
			`Ask ${dropped} is dropped: only an open ask drops`,
		);
	});

	it("reads the open asks with any reader", async () => {
		const { asks, place } = handles();

		const [open, dropped] = await commit(async (tx) => {
			const added = await asks.add(tx, [{ input: { title: "Open" } }, { input: { title: "Closed" } }], "pi-open", 4);

			return added.map((ask) => ask.id);
		});

		if (open === undefined || dropped === undefined) throw new Error("no asks");
		await commit((tx) => asks.drop(tx, dropped, "pi-open"));
		const listed = (await asks.open(place.store, BACKGROUND_CONTEXT)).asks;
		expect(listed.every((ask) => ask.state === "open")).toBe(true);
		expect(listed.map((ask) => ask.id)).toContain(open);
		expect(listed.map((ask) => ask.id)).not.toContain(dropped);
		expect((await asks.read(place.store, BACKGROUND_CONTEXT)).asks.map((ask) => ask.id)).toContain(dropped);
	});

	it("loads the asks of a store file with their IDs", async () => {
		const { asks } = handles();
		const loaded: Ask = { id: 900, title: "Loaded", state: "open", asker: "pi-file", at: 3, by: "pi-file" };
		await commit((tx) => asks.load(tx, [loaded]));
		expect(await readAsk(900)).toEqual(loaded);
	});
});

describe("the todos handle of an entry", { timeout: 30_000 }, () => {
	it("gives the list of a conversation in a commit, and whether it exists", async () => {
		const { todos, place } = handles();
		expect(await todos.has(place.store, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toBe(false);

		await commit(async (tx) => {
			(await todos.draft(tx, ROOT_CONVERSATION_ID)).todos.push({ id: 1, text: "From the entry", state: "open" });
		});

		expect(await todos.has(place.store, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toBe(true);
		expect(await send({ type: "todo", caller: "cli", action: "list", handle: "agent" })).toEqual({
			todos: [{ id: 1, text: "From the entry", state: "open" }],
		});
	});

	it("loads the lists of the callers of a store file", async () => {
		const { todos } = handles();
		const loaded = { id: 4, text: "Loaded todo", state: "doing" } as const;
		await commit((tx) => todos.load(tx, ROOT_CONVERSATION_ID, [], [{ caller: "pi-file", todos: [loaded] }]));
		expect(await send({ type: "todo", caller: "pi-file", action: "list" })).toEqual({ todos: [loaded] });
	});

	it("reads the list of a conversation and the lists of the callers", async () => {
		const { todos, place } = handles();
		await send({ type: "todo", caller: "pi-reader", action: "add", text: "Caller todo" });
		await send({ type: "todo", caller: "cli", action: "add", handle: "agent", text: "Agent todo" });
		const list = await todos.read(place.store, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		expect(list.todos.map((todo) => todo.text)).toContain("Agent todo");
		expect(await todos.read(place.store, OTHER, BACKGROUND_CONTEXT)).toEqual({
			todos: [],
		});
		const callers = await todos.callers(place.store, opened().storage, BACKGROUND_CONTEXT);
		expect(callers.find((caller) => caller.caller === "pi-reader")?.todos).toEqual([
			{ id: 1, text: "Caller todo", state: "open" },
		]);
	});

	it("tells which commit changes can change the lists", async () => {
		const { todos } = handles();
		const changes: (readonly CommitChange[])[] = [];

		const observation = opened().harness.observeCommits({
			advance: (publication) => {
				changes.push(publication.changes);
			},
			end: () => {},
		});

		await send({ type: "todo", caller: "pi-changes", action: "add", text: "Caller change" });
		await send({ type: "todo", caller: "cli", action: "add", handle: "agent", text: "Root change" });
		const listChanges = (id: ConversationId) => changes.flat().filter((change) => todos.changed(change, id));
		await until(() => listChanges(ROOT_CONVERSATION_ID).length >= 2);
		observation.detach();
		// The change of the list of the root counts for the root only; the change of a caller list counts for both.
		expect(listChanges(OTHER)).toHaveLength(listChanges(ROOT_CONVERSATION_ID).length - 1);
	});
});
