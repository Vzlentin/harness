import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ProjectStore } from "../src/projects/project-store.ts";
import { GateReply } from "../src/protocol/gate.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { Message, Person, Rule, Thread } from "../src/protocol/project.ts";
import { StoreFile } from "../src/protocol/store-file.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { cli, createProject, OPTIONS, readStores, root, send, setUp, startHost, tearDown } from "./helpers.ts";

/** Starts a host of `project`, stops it, and gives the lists of its stores. */
async function hostedFile(project: string): Promise<StoreFile> {
	const host = await startHost(project);
	await host.close();

	return readStores(project);
}

/** Runs `harness store load <path>` for `project`. */
function load(project: string, path: string) {
	return cli(["--project", project, "store", "load", path]);
}

/** Fills each list of the store of `project`, whose host runs. */
async function fill(project: string): Promise<void> {
	const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));
	const kim = Value.Parse(Person, await send({ type: "person", action: "add", name: "Kim" }, project));

	const threadOf = async (topic: string, persons: number[]) =>
		Value.Parse(Thread, await send({ type: "thread", action: "add", topic, persons }, project));

	const log = async (thread: number, from: number | "user", direction: "in" | "out", at: number, text: string) =>
		Value.Parse(
			Message,
			await send({ type: "message", action: "log", caller: "cli", thread, from, direction, at, text }, project),
		);

	const scope = await threadOf("Scope", [sam.id]);
	const asked = await log(scope.id, "user", "out", 1_000, "Which sale types?");
	await send({ type: "message", action: "mark", caller: "cli", message: asked.id, state: "sent" }, project);
	await log(scope.id, sam.id, "in", 2_000, "Only retail.");
	const dates = await threadOf("Dates", [kim.id, sam.id]);
	const sent = await log(dates.id, "user", "out", 3_000, "When?");
	const dropped = await log(dates.id, "user", "out", 4_000, "Never mind.");
	await log(dates.id, "user", "out", 5_000, "Still a draft.");
	await send({ type: "message", action: "mark", caller: "cli", message: sent.id, state: "sent" }, project);
	await send({ type: "message", action: "mark", caller: "cli", message: dropped.id, state: "dropped" }, project);

	const rule = (name: string, source: number) =>
		send(
			{
				type: "rule",
				action: "set",
				caller: "cli",
				saidBy: sam.id,
				source,
				name,
				kind: "conduct",
				value: `${name} first.`,
			},
			project,
		);

	const kept = Value.Parse(Rule, await rule("ask", asked.id));
	const gone = Value.Parse(Rule, await rule("wait", sent.id));
	await send({ type: "rule", action: "delete", caller: "cli", id: gone.id }, project);

	const gate = {
		type: "gate",
		requestId: "call-1",
		caller: "agent",
		tool: "bash",
		arguments: { command: `harness rule decide ${kept.id}` },
		messages: ["continue"],
	} as const;

	expect(Value.Parse(GateReply, await send(gate, project))).toMatchObject({ runs: false });

	await send(
		{
			type: "ask",
			action: "round",
			caller: "pi-1",
			parley: { slug: "where", title: "Where asks live", goal: "Pick the place.", design_sense: "One writer." },
			asks: [{ title: "Where", kind: "your call", options: OPTIONS, plan: "a" }, { title: "These are the terms" }],
		},
		project,
	);

	await send({ type: "todo", action: "add", caller: "cli", handle: AGENT_HANDLE, text: "Plan" }, project);
	await send({ type: "todo", action: "add", caller: "session-a", text: "Review" }, project);
}

beforeAll(async () => {
	await setUp();
});

afterAll(async () => {
	await tearDown();
});

describe("harness store load", { timeout: 60_000 }, () => {
	it("loads a store file into an empty store, keeps the IDs of threads, messages and rules, and refuses what it cannot load", async () => {
		await createProject("load-source");
		await createProject("load-target");
		await createProject("load-new");
		const empty = await hostedFile("load-target");
		expect(empty).toMatchObject({ persons: [], threads: [], rules: [] });

		const host = await startHost("load-source");

		try {
			await fill("load-source");
		} finally {
			await host.close();
		}

		const hosted = await readStores("load-source");
		const ask = hosted.asks[0]?.id;

		if (ask === undefined) throw new Error("no ask");
		// Each todo names an ask of the file, as the todo `Save to the vault` does, and the load keeps the link.
		const linked = (todos: StoreFile["todos"]) => todos.map((todo) => ({ ...todo, ask }));

		const source: StoreFile = {
			...hosted,
			todos: linked(hosted.todos),
			callerTodos: hosted.callerTodos.map((list) => ({ ...list, todos: linked(list.todos) })),
		};

		expect(source.lastRule).toBeGreaterThan(source.rules.at(-1)?.id ?? 0);
		expect(source.rules.map((rule) => rule.thread)).toEqual([source.threads[0]?.id]);
		const outs = source.threads.flatMap((thread) => thread.messages.filter((message) => message.direction === "out"));
		expect(outs.map((out) => out.state).sort()).toEqual(["answered", "draft", "dropped", "sent"]);
		const path = join(root, "load-source.json");
		await writeFile(path, JSON.stringify(source));

		// Into a store whose root conversation exists.
		expect(await load("load-target", path)).toMatchObject({ code: 0, stderr: "" });
		const loaded = await hostedFile("load-target");
		expect(loaded).toEqual(source);

		// Into a store that never had a host, so the load creates its root conversation.
		expect(await load("load-new", path)).toEqual({
			code: 0,
			stdout:
				"persons: 2\nthreads: 2\nmessages: 5\nrules: 1\nheld: 1\nparleys: 1\nasks: 2\noutbox: 4\ntodos: 1\ncallerTodos: 1\nitems: 0\n",
			stderr: "",
		});

		expect(await hostedFile("load-new")).toEqual(source);

		// A rule that an older file gives with a source and no thread gets the thread of its source message.
		await createProject("load-old");
		const old = join(root, "load-old.json");
		const oldRules = source.rules.map((rule) => ({ ...rule, thread: undefined }));
		await writeFile(old, JSON.stringify({ ...source, rules: oldRules }));
		expect(await load("load-old", old)).toMatchObject({ code: 0, stderr: "" });
		expect(await hostedFile("load-old")).toEqual(source);

		// A store that is not empty stays as it is.
		expect(await load("load-target", path)).toEqual({
			code: 1,
			stdout: "",
			stderr: "The store of load-target is not empty: harness store load writes only into an empty store\n",
		});

		expect(await hostedFile("load-target")).toEqual(loaded);

		// A running host keeps the lock, and its lists stay as they are.
		const running = await startHost("load-target");

		try {
			expect(await load("load-target", path)).toEqual({
				code: 1,
				stdout: "",
				stderr: "A harness host runs for load-target: stop it, then run harness store load again\n",
			});

			expect(await send({ type: "person", action: "list" }, "load-target")).toEqual({ persons: source.persons });
		} finally {
			await running.close();
		}
	});

	it("writes into an empty project.sqlite, which keeps its ID counters and its deliveries", async () => {
		await createProject("load-used");
		const { dir } = statePaths("load-used");
		await hostedFile("load-used");
		const delivery = { key: "approve:1", target: "pi-1", text: "Approved.", at: 1 };
		const rule = { name: "a", kind: "conduct", value: "A.", status: "open", saidBy: "user", at: 1, by: "cli" } as const;
		const used = ProjectStore.open(dir, 0);

		try {
			used.write((tx) => {
				for (let n = 0; n < 3; n++) tx.removeRule(tx.addRule(rule).id);
				tx.addDelivery(delivery);
			});
		} finally {
			used.close();
		}

		const path = join(root, "load-used.json");
		await writeFile(path, JSON.stringify(Value.Create(StoreFile)));
		expect(await load("load-used", path)).toMatchObject({ code: 0, stderr: "" });
		const loaded = ProjectStore.open(dir, 0);

		try {
			expect(loaded.lastRule()).toBe(3);
			expect(loaded.deliveries()).toEqual([delivery]);
			expect(loaded.write((tx) => tx.addRule(rule)).id).toBe(4);
		} finally {
			loaded.close();
		}
	});

	it("keeps the edits and deletes of messages in a store file, which loads", async () => {
		await createProject("edit-source");
		await createProject("edit-target");
		const host = await startHost("edit-source");
		let draft: Message;
		let rule: Rule;

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, "edit-source"));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, "edit-source"),
			);

			const log = async (from: number | "user", direction: "in" | "out", at: number, text: string) =>
				Value.Parse(
					Message,
					await send(
						{ type: "message", action: "log", caller: "cli", thread: thread.id, from, direction, at, text },
						"edit-source",
					),
				);

			const written = await log("user", "out", 1_000, "Which types?");
			// An earlier message in moves no draft.
			const asked = await log(sam.id, "in", 500, "Only retail.");
			const edit = { type: "message", action: "edit", caller: "cli", message: written.id } as const;
			draft = Value.Parse(Message, await send({ ...edit, text: "Which sale types?", at: 3_000 }, "edit-source"));

			const set = {
				type: "rule",
				action: "set",
				caller: "cli",
				saidBy: sam.id,
				source: asked.id,
				name: "retail",
				kind: "domain",
				value: "Only retail.",
			} as const;

			const added = Value.Parse(Rule, await send(set, "edit-source"));
			rule = Value.Parse(
				Rule,
				await send({ type: "rule", action: "retire", caller: "user", id: added.id }, "edit-source"),
			);
			await send({ type: "message", action: "delete", caller: "cli", message: asked.id }, "edit-source");
		} finally {
			await host.close();
		}

		const source = await readStores("edit-source");
		const { source: _source, thread: _thread, ...unsourced } = rule;
		const { state, by, thread: _of, ...message } = draft;
		expect(source.rules).toEqual([unsourced]);

		expect(source.threads).toEqual([
			{
				id: draft.thread,
				topic: "Scope",
				persons: [1],
				last: 3_000,
				messages: [{ ...message, thread: draft.thread, by, state, changed: { at: 1_000, by: "cli" } }],
			},
		]);

		const path = join(root, "edit-source.json");
		await writeFile(path, JSON.stringify(source));
		expect(await load("edit-target", path)).toMatchObject({ code: 0, stderr: "" });
		expect(await hostedFile("edit-target")).toEqual(source);
	});

	it("keeps the link of a loaded todo to its ask, so the note of the ask closes it", async () => {
		await createProject("link-source");
		await createProject("link-target");
		const source = await startHost("link-source");

		try {
			const asks = [{ title: "Where", kind: "your call" as const, options: OPTIONS, plan: "a" }];
			await send({ type: "ask", action: "round", caller: "1", asks }, "link-source");
		} finally {
			await source.close();
		}

		const hosted = await readStores("link-source");
		const ask = hosted.asks[0]?.id;

		if (ask === undefined) throw new Error("no ask");
		const todo = { id: 1, text: "Save to the vault: Where", state: "open" as const, ask };
		const path = join(root, "link-source.json");
		await writeFile(path, JSON.stringify({ ...hosted, todos: [todo] }));
		expect(await load("link-target", path)).toMatchObject({ code: 0, stderr: "" });

		const target = await startHost("link-target");

		try {
			await send({ type: "ask", action: "note", caller: "1", id: ask, note: "where" }, "link-target");
			expect(await send({ type: "todo", action: "list", caller: "1" }, "link-target")).toEqual({
				todos: [{ ...todo, state: "done" }],
			});
		} finally {
			await target.close();
		}
	});

	it("loads a file of version 1 with its open todos moved to items, and a file of version 2 with its items", async () => {
		await createProject("load-v1");
		await createProject("load-v2");
		const { version: _version, items: _items, lastItem: _lastItem, ...lists } = Value.Create(StoreFile);

		const todos = [
			{ id: 1, text: "Plan", state: "open" },
			{ id: 2, text: "Old", state: "done" },
			{ id: 3, text: "Ship", state: "doing" },
		] as const;

		const v1 = join(root, "load-v1.json");
		await writeFile(v1, JSON.stringify({ ...lists, version: 1, todos }));
		const loaded = await load("load-v1", v1);
		expect(loaded).toMatchObject({ code: 0, stderr: "" });
		expect(loaded.stdout).toContain("todos: 3\ncallerTodos: 0\nitems: 2\n");
		const moved = await hostedFile("load-v1");
		const migrated = { state: "open", edges: [], at: expect.any(Number), by: "migration" };

		expect(moved).toMatchObject({
			version: 2,
			todos: [
				{ id: 1, text: "moved to item 1: Plan", state: "dropped" },
				{ id: 2, text: "Old", state: "done" },
				{ id: 3, text: "moved to item 3: Ship", state: "dropped" },
			],
			items: [
				{ id: 1, title: "Plan", ...migrated },
				{ id: 3, title: "Ship", ...migrated },
			],
			lastItem: 3,
		});

		// A file of version 2: its open todo stays a todo, and the counter takes the highest ID of the items.
		const edge = { from: "agent:7", kind: "serves", to: "item:2", at: 5, by: "cli" } as const;
		const needs = { from: "item:3", kind: "needs", to: "item:2", at: 6, by: "cli" } as const;

		const items = [
			{ id: 2, title: "Two", state: "open", edges: [edge], at: 5, by: "cli" },
			{ id: 3, title: "Three", state: "open", edges: [needs], at: 6, by: "cli" },
		] as const;

		const kept = [{ id: 1, text: "Private", state: "open" }] as const;
		const v2 = join(root, "load-v2.json");
		await writeFile(v2, JSON.stringify({ ...lists, version: 2, todos: kept, items, lastItem: 1 }));
		expect(await load("load-v2", v2)).toMatchObject({ code: 0, stderr: "" });
		expect(await hostedFile("load-v2")).toMatchObject({ todos: kept, items, lastItem: 3 });

		const host = await startHost("load-v2");

		try {
			expect(await send({ type: "item", action: "add", caller: "cli", title: "Next" }, "load-v2")).toMatchObject({
				id: 4,
			});
			expect(await send({ type: "item", action: "read", id: 2 }, "load-v2")).toMatchObject({ edges: [edge, needs] });
			expect(await send({ type: "todo", action: "list", caller: "cli", handle: AGENT_HANDLE }, "load-v2")).toEqual({
				todos: kept,
			});
		} finally {
			await host.close();
		}
	});

	it("refuses a file that is not a store file before it opens the store", async () => {
		await createProject("load-refused");
		const store = join(statePaths("load-refused").dir, "durable.sqlite");
		const base = Value.Create(StoreFile);

		const changed = { at: 1, by: "cli" };
		const fields = { id: 9, thread: 3, from: "user", state: "draft", at: 1, text: "Hi", by: "cli" };
		const message = { ...fields, direction: "out", changed };
		const thread = { id: 3, topic: "Scope", persons: [1], messages: [message] };

		const cases = [
			["not-json.json", "{", "not-json.json is not a store file: "],
			[
				"version.json",
				JSON.stringify({ ...base, version: 3 }),
				"has the version 3: harness store load reads only the versions 1 and 2",
			],
			["schema.json", JSON.stringify({ ...base, persons: [{ id: 1 }] }), "is not a store file: /persons/0"],
			[
				"no-change.json",
				JSON.stringify({ ...base, threads: [{ ...thread, messages: [fields] }] }),
				"is not a store file: /threads/0/messages/0",
			],
			[
				"change-in.json",
				JSON.stringify({
					...base,
					threads: [{ ...thread, messages: [{ ...fields, direction: "in", state: "received", changed }] }],
				}),
				"is not a store file: /threads/0/messages/0",
			],
			[
				"other-thread.json",
				JSON.stringify({ ...base, threads: [{ ...thread, messages: [{ ...message, thread: 4 }] }] }),
				"is not a store file: message 9 names the thread 4, not 3",
			],
			[
				"source.json",
				JSON.stringify({
					...base,
					threads: [thread],
					rules: [
						{
							id: 1,
							name: "a",
							kind: "conduct",
							value: "A.",
							status: "open",
							saidBy: "user",
							source: 8,
							at: 1,
							by: "cli",
						},
					],
					lastRule: 1,
				}),
				"is not a store file: the source of the rule 1 is no message of the file",
			],
		] as const;

		for (const [name, text, line] of cases) {
			const path = join(root, name);
			await writeFile(path, text);
			const result = await load("load-refused", path);
			expect(result).toMatchObject({ code: 1, stdout: "" });
			expect(result.stderr).toContain(line);
			expect(result.stderr.startsWith(path)).toBe(true);
			expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
			expect(existsSync(store)).toBe(false);
		}

		const todo = (id: number) => ({ id, text: "Plan", state: "open" });
		const edge = { from: "agent:7", kind: "serves", to: "item:2", at: 1, by: "cli" };
		const needs = { from: "item:2", kind: "needs", to: "item:1", at: 1, by: "cli" };

		const item = (id: number, edges: readonly object[]) => ({
			id,
			title: "Ship",
			state: "open",
			edges,
			at: 1,
			by: "cli",
		});

		const twice = { ...base, threads: [thread] };

		const exact = [
			[
				"same-message.json",
				{
					...base,
					threads: [
						{ ...thread, id: 5, messages: [{ ...message, id: 10, thread: 5 }] },
						{ ...thread, id: 6, messages: [{ ...message, id: 10, thread: 6 }] },
					],
				},
				"the messages have the ID 10 twice",
			],
			[
				"same-thread.json",
				{ ...base, threads: [thread, { ...thread, messages: [] }] },
				"the threads have the ID 3 twice",
			],
			[
				"same-person.json",
				{
					...twice,
					persons: [
						{ id: 1, name: "Sam" },
						{ id: 1, name: "Kim" },
					],
				},
				"the persons have the ID 1 twice",
			],
			["same-todo.json", { ...twice, todos: [todo(1), todo(1)] }, "the todos have the ID 1 twice"],
			[
				"same-caller-todo.json",
				{ ...twice, callerTodos: [{ caller: "session-a", todos: [todo(2), todo(2)] }] },
				"the todos of session-a have the ID 2 twice",
			],
			[
				"same-caller.json",
				{
					...twice,
					callerTodos: [
						{ caller: "session-a", todos: [todo(1)] },
						{ caller: "session-a", todos: [todo(1)] },
					],
				},
				"callerTodos has the caller session-a twice",
			],
			["todo-ask.json", { ...twice, todos: [{ ...todo(1), ask: 4 }] }, "the ask of the todo 1 is no ask of the file"],
			[
				"caller-todo-ask.json",
				{ ...twice, callerTodos: [{ caller: "session-a", todos: [todo(1), { ...todo(2), ask: 4 }] }] },
				"the ask of the todo 2 of session-a is no ask of the file",
			],
			["same-item.json", { ...twice, items: [item(2, []), item(2, [])], lastItem: 2 }, "the items have the ID 2 twice"],
			[
				"other-item.json",
				{ ...twice, items: [item(2, [{ ...edge, to: "item:3" }])], lastItem: 3 },
				"the edge agent:7 serves item:3 is not an edge of the item 2",
			],
			[
				"edge-ends.json",
				{ ...twice, items: [item(2, [{ ...edge, kind: "landed" }])], lastItem: 2 },
				"the edge agent:7 landed item:2 is not an edge of the item 2",
			],
			[
				"needs-on-to.json",
				{ ...twice, items: [item(2, [{ ...edge, from: "item:1", kind: "needs" }])], lastItem: 2 },
				"the edge item:1 needs item:2 is not an edge of the item 2",
			],
			[
				"needs-unknown.json",
				{ ...twice, items: [item(2, [{ ...needs, to: "item:99" }])], lastItem: 2 },
				"the edge item:2 needs item:99 goes to no item of the file",
			],
			[
				"needs-cycle.json",
				{
					...twice,
					items: [
						item(1, [{ ...needs, from: "item:1", to: "item:2" }]),
						item(2, [needs]),
						item(3, [{ ...needs, from: "item:3", to: "item:2" }]),
					],
					lastItem: 3,
				},
				"the needs edges make a cycle through the item 1",
			],
			[
				"needs-self.json",
				{ ...twice, items: [item(2, [{ ...needs, to: "item:2" }])], lastItem: 2 },
				"the needs edges make a cycle through the item 2",
			],
		] as const;

		for (const [name, file, reason] of exact) {
			const path = join(root, name);
			await writeFile(path, JSON.stringify(file));

			expect(await load("load-refused", path)).toEqual({
				code: 1,
				stdout: "",
				stderr: `${path} is not a store file: ${reason}\n`,
			});

			expect(existsSync(store)).toBe(false);
		}
	});
});
