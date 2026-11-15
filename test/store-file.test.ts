import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { AskWrite, Message, Person, Rule, Thread } from "../src/protocol/project.ts";
import { STORE_FILE_VERSION } from "../src/protocol/store-file.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { Todo } from "../src/protocol/todo.ts";
import { projectHost, readStoreFile, send, setUp, tearDown, until } from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

beforeAll(async () => {
	await setUp();
	setEntry("todo-fixture", join(FIXTURE, "todo.ts"));
});

afterAll(async () => {
	await tearDown();
});

describe("store.json", { timeout: 30_000 }, () => {
	it("has every list of the store after each commit that changes one", async () => {
		const project = "store-file";
		const host = await projectHost(project);

		try {
			await until(() => readStoreFile(project) !== undefined);
			expect(readStoreFile(project)).toEqual({
				version: STORE_FILE_VERSION,
				persons: [],
				threads: [],
				rules: [],
				lastRule: 0,
				held: [],
				parleys: [],
				asks: [],
				todos: [],
				callerTodos: [],
			});

			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
			);

			const message = Value.Parse(
				Message,
				await send(
					{
						type: "message",
						action: "log",
						caller: "cli",
						thread: thread.id,
						from: "user",
						direction: "out",
						at: 1_000,
						text: "Which sale types?",
					},
					project,
				),
			);

			const rule = Value.Parse(
				Rule,
				await send(
					{
						type: "rule",
						action: "set",
						caller: "cli",
						saidBy: sam.id,
						source: message.id,
						name: "ask",
						kind: "conduct",
						value: "Ask first.",
					},
					project,
				),
			);

			await send({ type: "ask", action: "round", caller: "cli", asks: [{ title: "Push now?" }] }, project);

			const answered = Value.Parse(
				AskWrite,
				await send(
					{
						type: "ask",
						action: "answer",
						caller: "cli",
						user: true,
						answers: [{ id: 1, answer: "own", label: "Yes" }],
					},
					project,
				),
			).asks;

			expect(answered).toMatchObject([{ state: "answered", author: { kind: "user" } }]);

			const agentTodo = Value.Parse(
				Todo,
				await send({ type: "todo", action: "add", caller: "cli", handle: AGENT_HANDLE, text: "Plan" }, project),
			);

			// A task todo and a digest are in the store, not in the file.
			const key = "store-file-task";
			const taskText = "only in the list of the task";
			await send({ type: "start", kind: "fixture.todo", key, input: { texts: ["one", taskText, "three"] } }, project);
			expect(await send({ type: "wait-task", key }, project)).toMatchObject({ status: "terminal" });
			const digest = await send({ type: "digest", caller: "digest-caller" }, project);
			expect(digest.text).toContain("waiting on:");

			const sessionTodo = Value.Parse(
				Todo,
				await send({ type: "todo", action: "add", caller: "session-b", text: "Review" }, project),
			);

			const otherTodo = Value.Parse(
				Todo,
				await send({ type: "todo", action: "add", caller: "session-a", text: "Test" }, project),
			);

			await until(() => readStoreFile(project)?.callerTodos.length === 2);
			const file = readStoreFile(project);
			const text = readFileSync(statePaths(project).store, "utf8");

			expect(Object.keys(JSON.parse(text)).sort()).toEqual(
				[
					"version",
					"persons",
					"threads",
					"rules",
					"lastRule",
					"held",
					"parleys",
					"asks",
					"todos",
					"callerTodos",
				].sort(),
			);

			expect(text).not.toContain(taskText);
			expect(text).not.toContain("digest-caller");
			expect(text).not.toContain("waiting on:");

			expect(file).toMatchObject({
				version: STORE_FILE_VERSION,
				persons: [sam],
				// The message out has the last change of its state, and the file has no outbox.
				threads: [{ ...thread, last: message.at, messages: [{ ...message, changed: { at: message.at, by: "cli" } }] }],
				rules: [rule],
				lastRule: rule.id,
				asks: answered,
				todos: [agentTodo],
				callerTodos: [
					{ caller: "session-a", todos: [otherTodo] },
					{ caller: "session-b", todos: [sessionTodo] },
				],
			});
		} finally {
			await host.close();
		}
	});

	it("warns when it cannot write the file, and the commit succeeds", async () => {
		const project = "store-file-fails";
		const path = statePaths(project).store;
		const stderr = vi.spyOn(process.stderr, "write");
		let host: Host | undefined;

		try {
			// A folder where the file goes makes the rename fail.
			await mkdir(path, { recursive: true });
			host = await projectHost(project);

			const warning = () =>
				stderr.mock.calls.some(([text]) => String(text).startsWith(`warning: Could not write ${path}`));

			await until(warning);
			stderr.mockClear();

			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));
			expect(await send({ type: "person", action: "list" }, project)).toEqual({ persons: [sam] });
			await until(warning);
		} finally {
			stderr.mockRestore();
			await host?.close();
			await rm(path, { recursive: true, force: true });
		}
	});
});
