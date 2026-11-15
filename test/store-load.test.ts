import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GateReply } from "../src/protocol/gate.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { Message, Person, Rule, Thread } from "../src/protocol/project.ts";
import { StoreFile } from "../src/protocol/store-file.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import {
	cli,
	createProject,
	OPTIONS,
	readStoreFile,
	root,
	send,
	setUp,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

/** Starts a host of `project` with no `store.json`, takes the file that it writes, and stops it. */
async function hostedFile(project: string): Promise<StoreFile> {
	await rm(statePaths(project).store, { force: true });
	const host = await startHost(project);

	try {
		await until(() => readStoreFile(project) !== undefined);
	} finally {
		await host.close();
	}

	const file = readStoreFile(project);

	if (file === undefined) throw new Error("no store.json");

	return file;
}

/** Runs `harness store load <path>` for `project`. */
function load(project: string, path: string) {
	return cli(["--project", project, "store", "load", path]);
}

/** `file` with the IDs of its threads and messages put back to the IDs of `before`, by thread and message order. */
function idsOf(file: StoreFile, before: StoreFile): StoreFile {
	const threads = new Map(file.threads.map((thread, index) => [thread.id, before.threads[index]?.id ?? -1]));
	const messages = new Map<number, number>();

	file.threads.forEach((thread, index) =>
		thread.messages.forEach((message, at) => messages.set(message.id, before.threads[index]?.messages[at]?.id ?? -1)),
	);

	const thread = (id: number) => threads.get(id) ?? -1;
	const message = (id: number) => messages.get(id) ?? -1;

	return {
		...file,
		threads: file.threads.map((found) => ({
			...found,
			id: thread(found.id),
			messages: found.messages.map((one) => ({ ...one, id: message(one.id), thread: thread(one.thread) })),
		})),
		rules: file.rules.map((rule) => (rule.source === undefined ? rule : { ...rule, source: message(rule.source) })),
	};
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
	it("loads store.json into an empty store, maps the IDs of threads and messages, and refuses what it cannot load", async () => {
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

		const source = readStoreFile("load-source");

		if (source === undefined) throw new Error("no store.json");
		expect(source.lastRule).toBeGreaterThan(source.rules.at(-1)?.id ?? 0);
		const outs = source.threads.flatMap((thread) => thread.messages.filter((message) => message.direction === "out"));
		expect(outs.map((out) => out.state).sort()).toEqual(["answered", "draft", "dropped", "sent"]);
		const path = join(root, "load-source.json");
		await writeFile(path, JSON.stringify(source));

		// Into a store whose root conversation exists.
		expect(await load("load-target", path)).toMatchObject({ code: 0, stderr: "" });
		const loaded = await hostedFile("load-target");
		expect(loaded.threads.map((thread) => thread.id)).not.toEqual(source.threads.map((thread) => thread.id));
		expect(idsOf(loaded, source)).toEqual(source);

		// Into a store that never had a host, so the load creates its root conversation.
		expect(await load("load-new", path)).toEqual({
			code: 0,
			stdout:
				"persons: 2\nthreads: 2\nmessages: 5\nrules: 1\nheld: 1\nparleys: 1\nasks: 2\noutbox: 4\ntodos: 1\ncallerTodos: 1\n",
			stderr: "",
		});

		expect(idsOf(await hostedFile("load-new"), source)).toEqual(source);

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

	it("refuses a file that is not a store file before it opens the store", async () => {
		await createProject("load-refused");
		const store = join(statePaths("load-refused").dir, "durable.sqlite");
		const base = { ...Value.Create(StoreFile), version: 1 };

		const changed = { at: 1, by: "cli" };
		const fields = { id: 9, thread: 3, from: "user", state: "draft", at: 1, text: "Hi", by: "cli" };
		const message = { ...fields, direction: "out", changed };
		const thread = { id: 3, topic: "Scope", persons: [1], messages: [message] };

		const cases = [
			["not-json.json", "{", "not-json.json is not a store file: "],
			[
				"version.json",
				JSON.stringify({ ...base, version: 2 }),
				"has the version 2: harness store load reads only the version 1",
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
