import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { AGENT_HANDLE, type ListRef } from "../src/protocol/target.ts";
import { ClassifyReply, Todo } from "../src/protocol/todo.ts";
import { cli, models, root, setUp, spawnAs, startHost, tearDown } from "./helpers.ts";

const NO_CLASSIFIER = "No classifier: log in to typesafe or set todoClassifier";

/** Whether the classifier provider has a credential. */
let loggedIn = true;

/** The model and the context of each call of the classifier. */
const asked: { readonly model: string; readonly context: ClassifierContext }[] = [];

/** The state that `classify-todos` gives the classifier. */
const AskedState = Type.Object({
	todo: Type.Object({ id: Type.Integer(), text: Type.String() }),
	earlier: Type.Array(Todo),
});

let host: Host | undefined;

function classifierModel(id: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "test-classify",
		provider: "typesafe",
		baseUrl: "http://classifier.test",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
	};
}

/**
 * The classifier of the tests: a todo whose text asks to decide needs the user, and a todo repeats the earlier todo with
 * the same text. A todo with the text `Fail the classifier` gets an error result.
 */
async function classify(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	_options?: ClassifierOptions,
): Promise<ClassifierResult> {
	asked.push({ model: model.id, context });
	const result = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };

	if (!Value.Check(AskedState, context.state)) throw new Error(`unexpected state: ${JSON.stringify(context.state)}`);
	const { todo, earlier } = context.state;

	if (todo.text === "Fail the classifier") {
		return { ...result, answers: {}, stopReason: "error", errorMessage: "overloaded" };
	}

	const repeated = earlier.find((found) => found.text === todo.text);

	const answers: ClassifierResult["answers"] = {
		needsYou: { type: "bool", probability: todo.text.startsWith("Decide") ? 0.9 : 0.1 },
	};

	if (context.questions.repeats !== undefined) {
		const choice = repeated === undefined ? "none" : String(repeated.id);
		answers.repeats = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
	}

	return { ...result, answers, stopReason: "stop" };
}

/** Sends `line` to the host through the socket. */
async function send<T extends Request["type"]>(line: Extract<Request, { type: T }>): Promise<Replies[T]> {
	const reply = await request(line, { start: false });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/** Adds the todo `text` to the list `list`, and gives its ID. */
async function add(list: ListRef, text: string): Promise<number> {
	const todo = await send({ type: "todo", caller: "cli", action: "add", ...list, text });

	if ("todos" in todo) throw new Error("a list, not a todo");

	return todo.id;
}

/** The reply of `classify-todos` with `fields`, checked against its schema. */
async function classifyTodos(fields: Omit<Extract<Request, { type: "classify-todos" }>, "type"> = {}) {
	const reply = await send({ type: "classify-todos", ...fields });
	expect(Value.Check(ClassifyReply, reply)).toBe(true);

	return reply;
}

/** Writes Pi's global settings of the tests, with `todoClassifier` when it is given. */
async function setClassifier(name: string | undefined): Promise<void> {
	const settings =
		name === undefined ? { retry: { enabled: false } } : { retry: { enabled: false }, todoClassifier: name };

	await writeFile(join(root, "agent", "settings.json"), JSON.stringify(settings));
}

beforeAll(async () => {
	await setUp();

	models.setProvider(
		createProvider({
			id: "typesafe",
			auth: { apiKey: { name: "Test key", resolve: async () => (loggedIn ? { auth: {} } : undefined) } },
			models: [classifierModel("jev-latest"), classifierModel("jev-small")],
			classifiers: { "test-classify": { classify } },
		}),
	);

	host = await startHost();
	const project = { handle: AGENT_HANDLE };

	for (const text of ["Write the spec", "Decide the release name", "Archive librlm", "Write the spec"]) {
		await add(project, text);
	}

	await send({ type: "todo", caller: "cli", action: "set", ...project, id: 3, state: "done" });
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

beforeEach(async () => {
	loggedIn = true;
	asked.length = 0;
	await setClassifier(undefined);
});

describe("classify-todos", { timeout: 30_000 }, () => {
	it("gives one answer for each open todo of the project list, from one call for each", async () => {
		const answers = [
			{ id: 1, needsYou: false },
			{ id: 2, needsYou: true },
			{ id: 4, needsYou: false, repeats: 1 },
		];

		expect(await classifyTodos()).toEqual({ answers });
		expect(asked.map(({ model, context }) => [model, context.state])).toEqual([
			["jev-latest", { todo: { id: 1, text: "Write the spec" }, earlier: [] }],
			[
				"jev-latest",
				{ todo: { id: 2, text: "Decide the release name" }, earlier: [expect.objectContaining({ id: 1 })] },
			],
			[
				"jev-latest",
				{
					todo: { id: 4, text: "Write the spec" },
					earlier: [
						{ id: 1, text: "Write the spec", state: "open" },
						{ id: 2, text: "Decide the release name", state: "open" },
						{ id: 3, text: "Archive librlm", state: "done" },
					],
				},
			],
		]);

		// The first todo has no earlier todo to repeat; a done todo can be repeated.
		expect(asked[0]?.context.questions.repeats).toBeUndefined();
		expect(asked[2]?.context.questions.repeats).toMatchObject({
			type: "choice",
			criteria: { none: expect.any(String), 1: expect.any(String), 2: expect.any(String), 3: expect.any(String) },
		});

		expect(await cli(["todo", "sort"])).toEqual({
			code: 0,
			stdout: "1  needs you: no  repeats: none\n2  needs you: yes  repeats: none\n4  needs you: no  repeats: 1\n",
			stderr: "",
		});
	});

	it("asks only about the open todos of `ids`, and of the list that the request names", async () => {
		expect(await classifyTodos({ ids: [4, 3] })).toEqual({ answers: [{ id: 4, needsYou: false, repeats: 1 }] });
		await expect(send({ type: "classify-todos", ids: [2, 9] })).rejects.toThrow("Unknown todo: 9");

		const child = await spawnAs("session-1", "Sorted child", { notify: false });
		expect(await cli(["todo", "sort", "--handle", child.handle])).toEqual({
			code: 0,
			stdout: "No open todos\n",
			stderr: "",
		});
		await add({ handle: child.handle }, "Decide the colour");
		asked.length = 0;
		expect(await classifyTodos({ list: { handle: child.handle } })).toEqual({
			answers: [{ id: 1, needsYou: true }],
		});
		expect(asked.map(({ context }) => context.state)).toEqual([
			{ todo: { id: 1, text: "Decide the colour" }, earlier: [] },
		]);
		expect(await cli(["todo", "sort", "--handle", child.handle])).toMatchObject({
			code: 0,
			stdout: "1  needs you: yes  repeats: none\n",
		});
		expect(await cli(["todo", "sort", "1"])).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("  harness todo [list | add <text> | set <id> <state> [--text <text>] | sort]\n"),
		});
	});

	it("uses the model of todoClassifier in Pi's settings", async () => {
		await setClassifier("typesafe/jev-small");
		expect(await classifyTodos({ ids: [1] })).toEqual({ answers: [{ id: 1, needsYou: false }] });
		expect(asked.map(({ model }) => model)).toEqual(["jev-small"]);

		await setClassifier("typesafe/jev-none");
		await expect(send({ type: "classify-todos" })).rejects.toThrow(NO_CLASSIFIER);
		await setClassifier("other/jev-latest");
		await expect(send({ type: "classify-todos" })).rejects.toThrow(
			"No classifier: log in to other or set todoClassifier",
		);
		await setClassifier("jev-latest");
		await expect(send({ type: "classify-todos" })).rejects.toThrow(
			"No classifier: log in to jev-latest or set todoClassifier",
		);
	});

	it("fails without a credential for the classifier, before it reads the list", async () => {
		loggedIn = false;
		await expect(send({ type: "classify-todos" })).rejects.toThrow(NO_CLASSIFIER);
		await expect(send({ type: "classify-todos", list: { key: "nope" } })).rejects.toThrow(NO_CLASSIFIER);
		expect(await cli(["todo", "sort"])).toEqual({ code: 1, stdout: "", stderr: `${NO_CLASSIFIER}\n` });
		expect(asked).toEqual([]);
	});

	it("fails with the error of the classifier", async () => {
		const id = await add({ handle: AGENT_HANDLE }, "Fail the classifier");
		await expect(send({ type: "classify-todos", ids: [id] })).rejects.toThrow(
			"The classifier typesafe/jev-latest failed: overloaded",
		);
		await send({ type: "todo", caller: "cli", action: "set", handle: AGENT_HANDLE, id, state: "dropped" });
	});
});
