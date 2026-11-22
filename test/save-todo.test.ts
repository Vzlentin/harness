import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { type CallerTodoList, readCallerTodos, readTodos } from "../src/host/todo.ts";
import { Ask } from "../src/protocol/asks.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { MAIN_PROJECT } from "../src/protocol/projects.ts";
import type { Todo } from "../src/protocol/todo.ts";
import {
	answer,
	listenAnswers,
	models,
	OPTIONS,
	root,
	round,
	send,
	setUp,
	spawnWithId,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

/** The conversation ID of the project agent of a new store. */
const AGENT = "1";

let host: Host | undefined;

/** The list of todos of `caller`: its own conversation, or its list as a caller. */
async function todosOf(caller: string): Promise<Todo[]> {
	const reply = await send({ type: "todo", action: "list", caller });

	if (!("todos" in reply)) throw new Error("no list");

	return reply.todos;
}

/** Writes one ask with options and no parley as `caller`, with the title `title`, and gives its ID. */
async function ask(caller: string, title: string): Promise<number> {
	const written = await round(caller, undefined, [{ title, kind: "your call", options: OPTIONS, plan: "a" }]);
	const id = written.asks[0]?.id;

	if (id === undefined) throw new Error("no ask");

	return id;
}

/** Sets the note of the ask `id` as `caller`. */
async function note(caller: string, id: number, text: string): Promise<Ask> {
	return Value.Parse(Ask, await send({ type: "ask", action: "note", caller, id, note: text }));
}

/**
 * Makes `caller` a Pi session that the host knows: its `answers` listener gets the answer of an ask that the user
 * answered before the listener came, so the host had written the session before it pushed. That ask gets no todo.
 */
async function knownSession(caller: string): Promise<() => void> {
	const warm = await ask(caller, "Warm up");
	await answer([{ id: warm, answer: "a" }]);
	const answers = listenAnswers(caller);
	await until(() => answers.deliveries.length === 1);

	return () => answers.listener.close();
}

/** The lists of the store of the main project: the list of the project agent, and the list of each caller. */
type StoreLists = { readonly todos: readonly Todo[]; readonly callerTodos: readonly CallerTodoList[] };

/** The lists of the store of the main project, which a program reads while its host is down. The host starts again. */
async function downLists(): Promise<StoreLists> {
	await host?.close();

	try {
		const storage = await openNodeSqliteStorage(join(statePaths(MAIN_PROJECT).dir, "durable.sqlite"));

		const harness = await Harness.open(
			storage,
			{ models, registry: createRegistry(), readOnly: true },
			BACKGROUND_CONTEXT,
		);

		try {
			const agent = { kind: "conversation", id: ROOT_CONVERSATION_ID } as const;
			const { todos } = await readTodos(harness, agent, BACKGROUND_CONTEXT);

			return { todos, callerTodos: await readCallerTodos(harness, storage, BACKGROUND_CONTEXT) };
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		host = await startHost();
	}
}

beforeAll(async () => {
	await setUp();
	// The host adds the todo only with a vault: the home of the test is a folder that exists.
	process.env.VAULT = process.env.HOME;
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the todo Save to the vault", { timeout: 60_000 }, () => {
	it("is added once to the list of a child at the answer, and the note sets it to done", async () => {
		const { id: child } = await spawnWithId("save-session");
		const asked = await ask(child, "Where asks live\nwith more words");
		expect(await todosOf(child)).toEqual([]);

		await answer([{ id: asked, answer: "a" }]);
		const added = { id: 1, text: "Save to the vault: Where asks live", state: "open", ask: asked };
		expect(await todosOf(child)).toEqual([added]);

		// A second answer and a changed answer add no second todo.
		await answer([{ id: asked, answer: "a" }]);
		await answer([{ id: asked, answer: "b" }]);
		expect(await todosOf(child)).toEqual([added]);

		expect(await note(child, asked, "where-asks-live")).toMatchObject({ note: "where-asks-live" });
		expect(await todosOf(child)).toEqual([{ ...added, state: "done" }]);

		// After the todo is done, a new answer adds none.
		await answer([{ id: asked, answer: "a" }]);
		expect(await todosOf(child)).toEqual([{ ...added, state: "done" }]);
	});

	it("is not added when VAULT is not set, names no folder, or names a path that stat cannot read", async () => {
		const close = await knownSession("pi-no-vault");
		const vault = process.env.VAULT;

		try {
			delete process.env.VAULT;
			const unset = await ask("pi-no-vault", "No vault");
			await answer([{ id: unset, answer: "a" }]);
			expect(await todosOf("pi-no-vault")).toEqual([]);

			process.env.VAULT = `${vault}/missing`;
			const missing = await ask("pi-no-vault", "Missing vault");
			await answer([{ id: missing, answer: "a" }]);
			expect(await todosOf("pi-no-vault")).toEqual([]);

			// A symlink to itself makes stat fail with ELOOP: the answer is written, with no todo.
			const loop = join(root, "vault-loop");
			await symlink(loop, loop);
			process.env.VAULT = loop;
			const looped = await ask("pi-no-vault", "Looped vault");
			const written = await answer([{ id: looped, answer: "a" }]);
			expect(written.asks).toMatchObject([{ id: looped, state: "answered", answer: "a" }]);
			expect(await todosOf("pi-no-vault")).toEqual([]);

			// The same session gets the todo once the vault is there.
			process.env.VAULT = vault;
			const found = await ask("pi-no-vault", "A vault");
			await answer([{ id: found, answer: "a" }]);
			expect(await todosOf("pi-no-vault")).toMatchObject([{ text: "Save to the vault: A vault", ask: found }]);
		} finally {
			process.env.VAULT = vault;
			close();
		}
	});

	it("goes to the list of the project agent, and a dropped todo stays dropped at the note", async () => {
		const asked = await ask(AGENT, "Which store");
		await answer([{ id: asked, answer: "a" }]);
		const todo = (await todosOf(AGENT)).find((found) => found.ask === asked);
		expect(todo).toMatchObject({ text: "Save to the vault: Which store", state: "open" });

		if (todo === undefined) throw new Error("no todo");
		await send({ type: "todo", action: "set", caller: AGENT, id: todo.id, state: "dropped" });
		await note(AGENT, asked, "which-store");
		expect((await todosOf(AGENT)).find((found) => found.ask === asked)).toEqual({ ...todo, state: "dropped" });

		expect((await downLists()).todos.find((found) => found.ask === asked)).toEqual({
			...todo,
			state: "dropped",
		});
	});

	it("ends the delivery of the answer with the line of the todo", async () => {
		const caller = "pi-told";
		const warm = await ask(caller, "Warm up");
		await answer([{ id: warm, answer: "a" }]);
		const answers = listenAnswers(caller);
		await until(() => answers.deliveries.length === 1);

		try {
			const alone = await ask(caller, "Which note");
			await answer([{ id: alone, answer: "a" }]);
			await until(() => answers.deliveries.length === 2);
			expect(answers.deliveries[1]?.text).toMatch(
				/^\d+ · Which note · your call · a · In the store\n○ 1 Save to the vault: Which note\n$/,
			);
		} finally {
			answers.listener.close();
		}
	});

	it("goes to the list of a known Pi session, which the store keeps with its ask", async () => {
		const close = await knownSession("pi-save");
		let asked: number;

		try {
			asked = await ask("pi-save", "Which vault");
			await answer([{ id: asked, answer: "own", label: "Mine", words: ["Mine."] }]);
		} finally {
			close();
		}

		const added = { id: 1, text: "Save to the vault: Which vault", state: "open", ask: asked };
		expect(await todosOf("pi-save")).toEqual([added]);
		expect((await downLists()).callerTodos.find((list) => list.caller === "pi-save")?.todos).toEqual([added]);
	});

	it("is set to done at the note after the host no longer knows the Pi session of the asker", async () => {
		await host?.close();
		host = await startHost(MAIN_PROJECT, { sessionEndMs: 200 });

		try {
			const close = await knownSession("pi-gone");
			const asked = await ask("pi-gone", "Which end");
			await answer([{ id: asked, answer: "a" }]);
			const added = { id: 1, text: "Save to the vault: Which end", state: "open", ask: asked };
			expect(await todosOf("pi-gone")).toEqual([added]);

			// With no answers listener, the host forgets the session after its end delay.
			close();
			await new Promise((resolve) => setTimeout(resolve, 1500));
			const run = await ask("pi-gone", "After the end");
			await answer([{ id: run, answer: "a" }]);
			expect(await todosOf("pi-gone")).toEqual([added]);

			await note("pi-gone", asked, "which-end");
			expect(await todosOf("pi-gone")).toEqual([{ ...added, state: "done" }]);
		} finally {
			await host.close();
			host = await startHost();
		}
	});

	it("is not looked for at the note of an ask that has none, so the note creates no list", async () => {
		const close = await knownSession("pi-quiet");

		try {
			const open = await ask("pi-quiet", "Still open");
			await note("pi-quiet", open, "still-open");

			// The warm-up ask, the ask before, was answered before the host knew pi-quiet, and has no todo.
			const warm = Value.Parse(Ask, await send({ type: "ask", action: "read", id: open - 1 }));
			expect(warm).toMatchObject({ asker: "pi-quiet", state: "answered" });
			await note("pi-quiet", warm.id, "warm-up");
			await send({ type: "todo", action: "add", caller: "pi-other", text: "Mark" });
		} finally {
			close();
		}

		const lists = (await downLists()).callerTodos.map((list) => list.caller);
		expect(lists).toContain("pi-other");
		expect(lists).not.toContain("pi-quiet");
	});

	it("is not added for an ask with a note, or an asker with no list", async () => {
		const { id: child } = await spawnWithId("save-none");
		const noted = await ask(child, "Noted first");
		await note(child, noted, "noted-first");
		await answer([{ id: noted, answer: "a" }]);
		expect(await todosOf(child)).toEqual([]);

		const run = await ask("workflows:r1", "From a run");
		await answer([{ id: run, answer: "a" }]);
		expect(await todosOf("workflows:r1")).toEqual([]);
	});
});
