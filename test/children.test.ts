import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import * as durable from "@earendil-works/pi-durable";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createChildren, type Owner, type Place, type Spec } from "../src/children/library.ts";
import { REMINDER } from "../src/children/respond.ts";
import { called, contexts, gates, models, requests, root, SCHEMA_ANSWER, setUp, tearDown, until } from "./helpers.ts";

const library = createChildren(durable);
const faux = { provider: "faux", model: "faux-1" } as const;

const schema = {
	type: "object",
	properties: { verdict: { type: "string" }, score: { type: "number" } },
	required: ["verdict", "score"],
};

let harness: Harness;
let place: Place;
let owner: Owner;

/** A task that runs until it is aborted, to own children as a workflows script task does. */
const Holder = durable.defineTask<null, { phase: "hold" }, null>({
	name: "test.holder",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (_task, runtime, taskContext) => {
			await runtime.sleepUntil(runtime.now() + 3_600_000, { phase: "hold" }, taskContext);
		},
	},
	abort: (_task, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

/** A tool that does nothing, so a child offers its name. */
function placeholder(name: string) {
	return durable.defineTool({
		name,
		description: `The ${name} placeholder`,
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => ({ output: [{ type: "text", text: name }] }),
	});
}

const DELEGATION = ["subagent", "workflow"];

/** A resumed pi-durable host over the sqlite file `name` in the test root, with the library and the test tools. */
async function openHarness(name: string): Promise<{ harness: Harness; place: Place }> {
	const registry = durable.createRegistry();
	registry.install(library.extension);
	registry.install(library.answerExtension);
	registry.install(durable.defineExtension({ name: "test-holder", tasks: [Holder] }));
	const tools = [...DELEGATION, "lookup"].map(placeholder);
	registry.install(durable.defineExtension({ name: "test-tools", tools }));
	const opened = await Harness.open(await openNodeSqliteStorage(join(root, name)), { models, registry }, context);
	opened.resume();

	return { harness: opened, place: { store: opened, models, registry: registry.snapshot() } };
}

beforeAll(async () => {
	await setUp();
	({ harness, place } = await openHarness("children.sqlite"));
	owner = { kind: "detached", root: await harness.root(context) };
});

afterAll(async () => {
	await harness.close(context);
	await tearDown();
});

describe("children library", { timeout: 30_000 }, () => {
	it("opens a child once per key, with its lineage and the depth limit", async () => {
		const child = await library.open(place, owner, "t:one", { root: "test", ...faux }, context);
		expect(child.lineage).toEqual({ key: "t:one", root: "test", depth: 1, limit: 2 });
		expect((await library.open(place, owner, "t:one", { root: "test", ...faux }, context)).id).toBe(child.id);
		const parent = String(child.id);
		const grandchild = await library.open(place, owner, "t:two", { parent, ...faux }, context);
		expect(grandchild.lineage).toEqual({ key: "t:two", root: "test", parent, depth: 2, limit: 2 });
		expect(await library.lineage(harness, parent, context)).toEqual(child.lineage);
		expect(await library.lineage(harness, "pi-session", context)).toBeUndefined();
		await expect(
			library.open(place, owner, "t:three", { parent: String(grandchild.id), ...faux }, context),
		).rejects.toThrow("Nested subagents are disabled");
	});

	it("takes the depth limit of the spec for a new tree, and keeps the tree's for a child of a child", async () => {
		const child = await library.open(place, owner, "t:limit-one", { root: "test", ...faux, limit: 3 }, context);
		expect(child.lineage).toMatchObject({ depth: 1, limit: 3 });
		const parent = String(child.id);
		const grandchild = await library.open(place, owner, "t:limit-two", { parent, ...faux, limit: 1 }, context);
		expect(grandchild.lineage).toMatchObject({ depth: 2, limit: 3 });

		const deeper = await library.open(
			place,
			owner,
			"t:limit-three",
			{ parent: String(grandchild.id), ...faux },
			context,
		);

		expect(deeper.lineage).toMatchObject({ depth: 3, limit: 3 });
		await expect(
			library.open(place, owner, "t:limit-four", { parent: String(deeper.id), ...faux }, context),
		).rejects.toThrow("Nested subagents are disabled");
	});

	it("refuses a spec without a model when the owner's agent has none, and an unknown model", async () => {
		await expect(library.open(place, owner, "t:none", { root: "test" }, context)).rejects.toThrow(
			"No model: neither the spec nor the owner's agent names one",
		);
		await expect(
			library.open(place, owner, "t:unknown", { root: "test", provider: "faux", model: "nope" }, context),
		).rejects.toThrow("Unknown model: faux/nope");
		expect(await library.find(place, owner, { key: "t:none" }, context)).toBeUndefined();
	});

	it("answers a request, sums the spend of the subtree and ends the subtree", async () => {
		const parent = await library.open(place, owner, "t:parent", { root: "test", ...faux, cwd: root }, context);

		const child = await library.open(
			place,
			owner,
			"t:child",
			{ parent: String(parent.id), ...faux, cwd: root },
			context,
		);

		await parent.send({ type: "input", content: "Hello", requestId: "r1" }, context);
		await child.send({ type: "input", content: "Hi", requestId: "r1" }, context);
		expect(await parent.settled(context)).toMatchObject({ status: "ok", text: "Answer to Hello" });
		expect(await child.settled(context, "r1")).toMatchObject({ status: "ok", text: "Answer to Hi" });
		expect(await parent.state(context)).toBe("idle");

		const tokens = async (id: typeof parent.id) =>
			(await harness.snapshot(durable.UsageDoc, id, context))?.models["faux/faux-1"]?.totalTokens ?? 0;

		const [parentTokens, childTokens] = [await tokens(parent.id), await tokens(child.id)];
		expect(parentTokens).toBeGreaterThan(0);
		expect(childTokens).toBeGreaterThan(0);
		expect((await parent.usage(context)).models["faux/faux-1"]?.totalTokens).toBe(parentTokens + childTokens);
		expect(await parent.close(context)).toEqual([parent.id, child.id]);
		expect(await child.state(context)).toBe("ended");
	});

	it("sums the usage of a tool named __proto__ as an own key", async () => {
		const child = await library.open(place, owner, "t:proto", { root: "test", ...faux }, context);
		const key = "__proto__";

		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		await harness.commit(async (tx) => {
			(await tx.doc(durable.UsageDoc, child.id)).tools[key] = usage;
		}, context);

		const { tools } = await child.usage(context);
		expect(Object.getPrototypeOf(tools)).toBe(Object.prototype);
		expect(Object.hasOwn(tools, key)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(tools, key)?.value).toEqual(usage);
	});

	it("refuses a child of another owner", async () => {
		const child = await library.open(place, owner, "t:mine", { root: "test", ...faux }, context);
		// SAFETY: a task ID is a number, and the owner check compares it without looking up the task.
		const other: Owner = { kind: "task", taskId: 999_999 as TaskId, conversation: child.id };
		await expect(library.find(place, other, { id: String(child.id) }, context)).rejects.toThrow(
			`The child ${child.id} belongs to another owner`,
		);
	});

	it("aborts the turn of a child when its owner task aborts", async () => {
		const rootConversation = await harness.root(context);

		const taskId = await rootConversation.commit(
			(tx) => tx.createTask(Holder, null, { ownership: { kind: "conversation" } }),
			context,
		);

		const taskOwner: Owner = { kind: "task", taskId, conversation: rootConversation.id };
		const child = await library.open(place, taskOwner, "t:owned", { root: "test", ...faux, cwd: root }, context);
		gates.set("Owned", Promise.withResolvers());
		await child.send({ type: "input", content: "Owned", requestId: "r1" }, context);
		await until(() => called("Owned") === 1);
		await harness.abortTask(taskId, context);
		expect(await child.settled(context, "r1")).toMatchObject({
			status: "failed",
			reason: "unanswered",
			cause: "aborted",
		});
	});

	it("finds the children of an ended task from a new task of its group, and only from that group", async () => {
		const rootConversation = await harness.root(context);

		const holder = () =>
			rootConversation.commit((tx) => tx.createTask(Holder, null, { ownership: { kind: "conversation" } }), context);

		const first = await holder();

		const ownerOf = (taskId: TaskId, group?: string): Owner =>
			group === undefined
				? { kind: "task", taskId, conversation: rootConversation.id }
				: { kind: "task", taskId, conversation: rootConversation.id, group };

		const child = await library.open(
			place,
			ownerOf(first, "run-1"),
			"t:group",
			{ root: "test", ...faux, cwd: root },
			context,
		);

		expect(await child.ask({ type: "input", content: "Grouped", requestId: "r1" }, context)).toMatchObject({
			status: "ok",
			text: "Answer to Grouped",
		});
		await harness.abortTask(first, context);
		const second = await holder();
		const found = await library.find(place, ownerOf(second, "run-1"), { key: "t:group" }, context);
		expect(found?.id).toBe(child.id);
		expect(await found?.ask({ type: "input", content: "Again", requestId: "r2" }, context)).toMatchObject({
			status: "ok",
			text: "Answer to Again",
		});

		for (const other of [ownerOf(second, "run-2"), ownerOf(first)]) {
			await expect(library.find(place, other, { key: "t:group" }, context)).rejects.toThrow(
				`The child ${child.id} belongs to another owner`,
			);
		}

		// An abort of the later task does not reach the turns it sent to the child of the earlier task.
		gates.set("Late", Promise.withResolvers());
		await found?.send({ type: "input", content: "Late", requestId: "r3" }, context);
		await until(() => called("Late") === 1);
		await harness.abortTask(second, context);
		expect(await found?.state(context)).toBe("busy");
		gates.get("Late")?.resolve();
		expect(await found?.settled(context, "r3")).toMatchObject({ status: "ok", text: "Answer to Late" });
		// A child saved without a group refuses a grouped owner, also of its own task.
		const third = await holder();
		const plain = await library.open(place, ownerOf(third), "t:plain", { root: "test", ...faux }, context);
		await expect(library.find(place, ownerOf(third, "run-1"), { key: "t:plain" }, context)).rejects.toThrow(
			`The child ${plain.id} belongs to another owner`,
		);
		await harness.abortTask(third, context);
	});

	it("ends only the subtree under a child with below, and the child keeps its state", async () => {
		const parent = await library.open(place, owner, "t:below", { root: "test", ...faux, cwd: root }, context);
		const child = await library.open(place, owner, "t:below-child", { parent: String(parent.id), ...faux }, context);
		expect(await parent.close(context, { below: true })).toEqual([child.id]);
		expect(await child.state(context)).toBe("ended");
		expect(await parent.state(context)).toBe("idle");
		expect(await parent.ask({ type: "input", content: "Still open", requestId: "r1" }, context)).toMatchObject({
			status: "ok",
			text: "Answer to Still open",
		});
	});

	it("ends only the child with alone, and its subtree keeps its state", async () => {
		const parent = await library.open(place, owner, "t:alone", { root: "test", ...faux, cwd: root }, context);
		const child = await library.open(place, owner, "t:alone-child", { parent: String(parent.id), ...faux }, context);
		expect(await parent.close(context, { alone: true })).toEqual([parent.id]);
		expect(await parent.state(context)).toBe("ended");
		expect(await child.state(context)).toBe("idle");
	});

	it("stops only the wait when a wait is cancelled", async () => {
		const child = await library.open(place, owner, "t:slow", { root: "test", ...faux, cwd: root }, context);
		const gate = Promise.withResolvers<void>();
		gates.set("Slow", gate);
		await child.send({ type: "input", content: "Slow", requestId: "r1" }, context);
		await until(() => called("Slow") === 1);
		const wait = withCancel(context);
		const waiting = child.settled(wait.context, "r1");
		wait.cancel();
		await expect(waiting).rejects.toThrow();
		gate.resolve();
		expect(await child.settled(context, "r1")).toMatchObject({ status: "ok", text: "Answer to Slow" });
	});

	it("withdraws queued input when it ends a child, and a new input resumes it", async () => {
		const child = await library.open(place, owner, "t:queue", { root: "test", ...faux, cwd: root }, context);
		gates.set("Busy", Promise.withResolvers());
		await child.send({ type: "input", content: "Busy", requestId: "r1" }, context);
		await until(() => called("Busy") === 1);
		await child.send({ type: "input", content: "Queued", whenBusy: "followUp", requestId: "r2" }, context);
		await child.close(context);
		expect(await child.state(context)).toBe("ended");
		expect(await child.settled(context, "r1")).toMatchObject({ status: "failed", reason: "unanswered" });
		expect(await child.settled(context, "r2")).toMatchObject({ status: "failed", reason: "unanswered" });
		expect(called("Queued")).toBe(0);
		gates.delete("Busy");
		await child.send({ type: "input", content: "Revived", requestId: "r3" }, context);
		expect(await child.settled(context, "r3")).toMatchObject({ status: "ok", text: "Answer to Revived" });
		expect(await child.state(context)).toBe("idle");
		expect(called("Queued")).toBe(0);
	});

	it("answers an ask to an ended child with its history", async () => {
		const child = await library.open(place, owner, "t:resume", { root: "test", ...faux, cwd: root }, context);
		await child.ask({ type: "input", content: "First of resume", requestId: "r1" }, context);
		await child.close(context);
		expect(await child.state(context)).toBe("ended");
		expect(await child.ask({ type: "input", content: "After the end", requestId: "r2" }, context)).toMatchObject({
			status: "ok",
			text: "Answer to After the end",
		});
		expect(contexts.get("After the end")).toEqual(["First of resume", "After the end"]);
		expect(await child.state(context)).toBe("idle");
	});

	it("resumes only the child that takes the input: its ended children stay ended", async () => {
		const parent = await library.open(place, owner, "t:resume-parent", { root: "test", ...faux, cwd: root }, context);
		const child = await library.open(place, owner, "t:resume-child", { parent: String(parent.id), ...faux }, context);
		await parent.close(context);
		await parent.ask({ type: "input", content: "Parent resumed", requestId: "r1" }, context);
		expect(await parent.state(context)).toBe("idle");
		expect(await child.state(context)).toBe("ended");
	});

	it("keeps a note to an ended child, and the child stays ended", async () => {
		const child = await library.open(place, owner, "t:ended-note", { root: "test", ...faux, cwd: root }, context);
		await child.close(context);
		const model = [{ role: "user", content: "Written after the end", timestamp: Date.now() }] as const;
		await child.conversation.submit({ type: "write", requestId: "w1", entry: { kind: "test.note", model } }, context);
		expect(await child.state(context)).toBe("ended");
		await child.ask({ type: "input", content: "After the note", requestId: "r1" }, context);
		expect(contexts.get("After the note")).toEqual(["Written after the end", "After the note"]);
	});

	it("does not resume an ended child for a request ID admitted before", async () => {
		const child = await library.open(place, owner, "t:ended-repeat", { root: "test", ...faux, cwd: root }, context);
		const input = { type: "input", content: "Repeated", requestId: "r1" } as const;
		await child.send(input, context);
		await child.settled(context, "r1");
		await child.close(context);
		await child.send(input, context);
		expect(called("Repeated")).toBe(1);
		expect(await child.state(context)).toBe("ended");
	});

	it("resumes an ended child with an input that waits for no answer, and keeps its last request", async () => {
		const child = await library.open(place, owner, "t:ended-input", { root: "test", ...faux, cwd: root }, context);
		await child.ask({ type: "input", content: "Before the input", requestId: "r1" }, context);
		await child.close(context);
		const inspected = await library.inspect(place, String(child.id), context);
		await inspected?.input({ type: "input", content: "Input after the end", requestId: "u1" }, context);
		await until(() => called("Input after the end") === 1);
		await child.conversation.waitForIdle(context);
		expect(contexts.get("Input after the end")).toEqual(["Before the input", "Input after the end"]);
		expect(await child.state(context)).toBe("idle");
		expect(await child.lastRequest(context)).toBe("r1");
	});

	it("refuses and aborts an input that waits for no answer when its child ends during the submit", async () => {
		const child = await library.open(place, owner, "t:input-race", { root: "test", ...faux, cwd: root }, context);
		const submit = child.conversation.submit.bind(child.conversation);

		vi.spyOn(child.conversation, "submit").mockImplementationOnce(async (...args) => {
			await child.close(context);

			return submit(...args);
		});

		gates.set("Input raced", Promise.withResolvers());
		await expect(child.input({ type: "input", content: "Input raced", requestId: "u1" }, context)).rejects.toThrow(
			`The child ${child.id} ended during the submit`,
		);
		expect(await child.state(context)).toBe("ended");
		await child.conversation.waitForIdle(context);
		expect(await child.state(context)).toBe("ended");
		gates.delete("Input raced");
	});

	it("aborts a busy subtree when it ends", async () => {
		const parent = await library.open(place, owner, "t:busy-end", { root: "test", ...faux, cwd: root }, context);
		const child = await library.open(place, owner, "t:busy-end-child", { parent: String(parent.id), ...faux }, context);
		gates.set("Parent busy", Promise.withResolvers());
		gates.set("Child busy", Promise.withResolvers());
		await parent.send({ type: "input", content: "Parent busy", requestId: "r1" }, context);
		await child.send({ type: "input", content: "Child busy", requestId: "r1" }, context);
		await until(() => called("Parent busy") === 1 && called("Child busy") === 1);
		expect(await parent.close(context)).toEqual([parent.id, child.id]);
		expect(await parent.settled(context, "r1")).toMatchObject({ status: "failed", reason: "unanswered" });
		expect(await child.settled(context, "r1")).toMatchObject({ status: "failed", reason: "unanswered" });
		expect([await parent.state(context), await child.state(context)]).toEqual(["ended", "ended"]);
		gates.delete("Parent busy");
		gates.delete("Child busy");
	});

	it("keeps the end in the store, and resumes the child with its history after a reopen", async () => {
		const first = await openHarness("children-reopen.sqlite");
		const firstOwner: Owner = { kind: "detached", root: await first.harness.root(context) };
		const spec = { root: "test", ...faux, cwd: root };
		const opened = await library.open(first.place, firstOwner, "t:reopen", spec, context);
		await opened.ask({ type: "input", content: "Before the reopen", requestId: "r1" }, context);
		await opened.close(context);
		await first.harness.close(context);

		const second = await openHarness("children-reopen.sqlite");

		try {
			const secondOwner: Owner = { kind: "detached", root: await second.harness.root(context) };
			const child = await library.find(second.place, secondOwner, { key: "t:reopen" }, context);
			expect(await child?.state(context)).toBe("ended");
			expect(await child?.ask({ type: "input", content: "After the reopen", requestId: "r2" }, context)).toMatchObject({
				status: "ok",
				text: "Answer to After the reopen",
			});
			expect(contexts.get("After the reopen")).toEqual(["Before the reopen", "After the reopen"]);
			expect(await child?.state(context)).toBe("idle");
		} finally {
			await second.harness.close(context);
		}
	});

	it("refuses an explicit thinking level that the model does not have", async () => {
		await expect(
			library.open(place, owner, "t:loud", { root: "test", ...faux, thinking: "xhigh" }, context),
		).rejects.toThrow("faux/faux-1 has no thinking level xhigh");
		expect(await library.find(place, owner, { key: "t:loud" }, context)).toBeUndefined();
	});

	it("gives an inherited thinking level that the model does not have as the nearest one", async () => {
		const rootConversation = await harness.root(context);
		await rootConversation.configure({ thinkingLevel: "xhigh" }, context);

		try {
			const child = await library.open(place, owner, "t:inherit", { root: "test", ...faux }, context);
			expect((await child.conversation.agent(context)).thinkingLevel).toBe("high");
			const fallback = { root: "test", ...faux, fallbackThinking: "xhigh" };
			const caller = await library.open(place, owner, "t:caller", fallback, context);
			expect((await caller.conversation.agent(context)).thinkingLevel).toBe("high");
		} finally {
			await rootConversation.configure({ thinkingLevel: null }, context);
		}
	});

	it("asks a turn and gives its answer", async () => {
		const child = await library.open(place, owner, "t:ask", { root: "test", ...faux, cwd: root }, context);
		expect(await child.ask({ type: "input", content: "Plain", requestId: "r1" }, context)).toMatchObject({
			status: "ok",
			text: "Answer to Plain",
		});
	});

	it("gives the respond answer of a schema ask as its value", async () => {
		const child = await library.open(place, owner, "t:schema", { root: "test", ...faux, cwd: root }, context);
		const answer = await child.ask({ type: "input", content: "Schema", requestId: "r1" }, context, { schema });
		expect(answer).toMatchObject({ status: "ok", text: "", value: SCHEMA_ANSWER });
	});

	it("parses a respond answer that is JSON text", async () => {
		const child = await library.open(place, owner, "t:text", { root: "test", ...faux, cwd: root }, context);
		const input = { type: "input", content: "Schema text", requestId: "r1" } as const;
		expect(await child.ask(input, context, { schema })).toMatchObject({ status: "ok", value: SCHEMA_ANSWER });
	});

	it("reminds a schema ask without respond twice, then gives no-respond", async () => {
		const child = await library.open(place, owner, "t:remind", { root: "test", ...faux, cwd: root }, context);
		const answer = await child.ask({ type: "input", content: "No respond", requestId: "r1" }, context, { schema });
		expect(called(REMINDER)).toBe(2);
		expect(answer).toMatchObject({ status: "failed", reason: "no-respond", text: `Answer to ${REMINDER}` });
	});

	it("a send after a schema ask gets no reminders", async () => {
		const child = await library.open(place, owner, "t:send-after-ask", { root: "test", ...faux, cwd: root }, context);
		await child.ask({ type: "input", content: "No respond", requestId: "r1" }, context, { schema });
		const reminders = called(REMINDER);
		await child.send({ type: "input", content: "Plain after", requestId: "r2" }, context);
		const answer = await child.settled(context, "r2");
		expect(called(REMINDER)).toBe(reminders);
		expect(answer).toMatchObject({ status: "ok", text: "Answer to Plain after" });
	});

	it("a duplicate send keeps a running schema ask", async () => {
		const child = await library.open(place, owner, "t:dup", { root: "test", ...faux, cwd: root }, context);
		const gate = Promise.withResolvers<void>();
		gates.set("Schema", gate);
		const input = { type: "input", content: "Schema", requestId: "r1" } as const;
		const before = called("Schema");
		const asked = child.ask(input, context, { schema });
		await until(() => called("Schema") === before + 1);
		await child.send(input, context);
		gate.resolve();
		gates.delete("Schema");
		expect(await asked).toMatchObject({ status: "ok", value: SCHEMA_ANSWER });
	});

	it("gives a cut answer as cut", async () => {
		const child = await library.open(place, owner, "t:cut", { root: "test", ...faux, cwd: root }, context);
		expect(await child.ask({ type: "input", content: "Cut", requestId: "r1" }, context)).toMatchObject({
			status: "failed",
			reason: "cut",
			text: "cut",
			stopReason: "length",
		});
	});

	it("sends an unanswered request again under the next request ID", async () => {
		const child = await library.open(place, owner, "t:retry", { root: "test", ...faux, cwd: root }, context);
		gates.set("Retry", Promise.withResolvers());
		const input = { type: "input", content: "Retry", requestId: "r1" } as const;
		const first = child.ask(input, context);
		await until(() => called("Retry") === 1);
		await child.conversation.abort(context);
		expect(await first).toMatchObject({ status: "failed", reason: "unanswered", cause: "aborted" });
		gates.delete("Retry");
		expect(await child.ask(input, context)).toMatchObject({ status: "ok", text: "Answer to Retry" });
		expect(await harness.commit((tx) => tx.submissionByRequest(child.id, "r1#2"), context)).toMatchObject({
			status: "done",
		});
	});

	it("gives the saved answer of a request answered before, with no new turn", async () => {
		const opened = await library.open(place, owner, "t:saved", { root: "test", ...faux, cwd: root }, context);
		const input = { type: "input", content: "Schema", requestId: "r1" } as const;
		const first = await opened.ask(input, context, { schema });
		expect(first).toMatchObject({ status: "ok", value: SCHEMA_ANSWER });
		const child = await library.find(place, owner, { key: "t:saved" }, context);
		const before = called("Schema");
		expect(await child?.ask(input, context, { schema })).toEqual(first);
		expect(called("Schema")).toBe(before);
	});

	it("keeps the extensions and model tools of the owner's agent", async () => {
		const rootConversation = await harness.root(context);
		await harness.commit(async (tx) => {
			const agent = await tx.doc(durable.AgentDoc, rootConversation.id);
			agent.extensions = { add: ["test-holder"] };
			agent.modelTools = { add: ["other"] };
		}, context);

		try {
			const child = await library.open(place, owner, "t:agent", { root: "test", ...faux, cwd: root }, context);
			await child.ask({ type: "input", content: "Schema", requestId: "r1" }, context, { schema });
			await child.send({ type: "input", content: "Plain", requestId: "r2" }, context);
			await child.settled(context, "r2");
			const agent = await harness.snapshot(durable.AgentDoc, child.id, context);
			expect(agent?.extensions).toEqual({ add: ["test-holder", "harness-answer"] });
			expect(agent?.modelTools).toEqual({ add: ["other"] });
		} finally {
			await rootConversation.configure({ extensions: null, modelTools: null }, context);
		}
	});

	it("turns off a respond copied from the owner's agent for a plain ask", async () => {
		const rootConversation = await harness.root(context);
		await harness.commit(async (tx) => {
			const agent = await tx.doc(durable.AgentDoc, rootConversation.id);
			agent.modelTools = { add: ["respond"] };
		}, context);

		try {
			const child = await library.open(place, owner, "t:copied", { root: "test", ...faux, cwd: root }, context);
			await child.ask({ type: "input", content: "Plain", requestId: "r1" }, context);
			const agent = await harness.snapshot(durable.AgentDoc, child.id, context);
			expect(agent?.modelTools).toEqual({ add: [] });
		} finally {
			await rootConversation.configure({ extensions: null, modelTools: null }, context);
		}
	});

	it("keeps a saved respond answer after a later turn", async () => {
		const child = await library.open(place, owner, "t:later", { root: "test", ...faux, cwd: root }, context);
		const input = { type: "input", content: "Schema", requestId: "r1" } as const;
		const first = await child.ask(input, context, { schema });
		await child.send({ type: "input", content: "Plain", requestId: "r2" }, context);
		await child.settled(context, "r2");
		const before = called("Schema");
		const again = await child.ask(input, context, { schema });
		expect(again).toEqual(first);

		if (again.status !== "ok") throw new Error(`The ask failed: ${again.reason}`);
		const value: JsonValue = again.value;
		expect(value).toEqual(SCHEMA_ANSWER);
		expect(called("Schema")).toBe(before);
	});

	it("gives no-respond to a schema ask of a child opened with Spec.tools", async () => {
		const spec = { root: "test", ...faux, cwd: root, tools: [] };
		const child = await library.open(place, owner, "t:tools", spec, context);
		const answer = await child.ask({ type: "input", content: "Schema", requestId: "r1" }, context, { schema });
		expect(answer).toMatchObject({ status: "failed", reason: "no-respond" });
	});

	it("gives a schema ask queued behind another schema ask only its own respond answer", async () => {
		const child = await library.open(place, owner, "t:ask-over-ask", { root: "test", ...faux, cwd: root }, context);
		const gate = Promise.withResolvers<void>();
		gates.set("Schema", gate);
		const before = called("Schema");
		const first = child.ask({ type: "input", content: "Schema", requestId: "r1" }, context, { schema });
		await until(() => called("Schema") === before + 1);
		const input = { type: "input", content: "No respond either", whenBusy: "followUp", requestId: "r2" } as const;
		const second = child.ask(input, context, { schema });

		while ((await harness.commit((tx) => tx.submissionByRequest(child.id, "r2"), context)) === undefined) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		gate.resolve();
		gates.delete("Schema");
		expect(await first).toMatchObject({ status: "failed", reason: "no-respond" });
		expect(await second).toMatchObject({ status: "failed", reason: "no-respond" });
	});

	it("keeps the last request when the submit of a send fails", async () => {
		const child = await library.open(place, owner, "t:failed-submit", { root: "test", ...faux, cwd: root }, context);
		await child.send({ type: "input", content: "Before", requestId: "r1" }, context);
		await child.settled(context, "r1");
		vi.spyOn(child.conversation, "submit").mockRejectedValueOnce(new Error("Stopped at submit"));
		await expect(child.send({ type: "input", content: "Lost", requestId: "r2" }, context)).rejects.toThrow(
			"Stopped at submit",
		);
		expect(await child.lastRequest(context)).toBe("r1");
		expect(await child.settled(context)).toMatchObject({ status: "ok", text: "Answer to Before" });
	});

	it("refuses and aborts a send whose child ends during the submit", async () => {
		const child = await library.open(place, owner, "t:close-race", { root: "test", ...faux, cwd: root }, context);
		const submit = child.conversation.submit.bind(child.conversation);

		vi.spyOn(child.conversation, "submit").mockImplementationOnce(async (...args) => {
			await child.close(context);

			return submit(...args);
		});

		gates.set("Raced", Promise.withResolvers());
		await expect(child.send({ type: "input", content: "Raced", requestId: "r1" }, context)).rejects.toThrow(
			`The child ${child.id} ended during the submit`,
		);
		expect(await child.settled(context, "r1")).toMatchObject({ status: "failed", reason: "unanswered" });
		expect(await child.state(context)).toBe("ended");
		gates.delete("Raced");
	});

	it("marks the whole subtree ended before it aborts any of it", async () => {
		const parent = await library.open(place, owner, "t:atomic", { root: "test", ...faux, cwd: root }, context);
		const child = await library.open(place, owner, "t:atomic-child", { parent: String(parent.id), ...faux }, context);
		const states: string[] = [];

		const watched: Place = {
			...place,
			store: {
				commit: (change, commitContext) => harness.commit(change, commitContext),
				snapshot: harness.snapshot.bind(harness),
				submission: (id, lookupContext) => harness.submission(id, lookupContext),
				conversation: async (id, lookupContext) => {
					states.push(await child.state(context));

					return harness.conversation(id, lookupContext);
				},
			},
		};

		const closing = await library.find(watched, owner, { id: String(parent.id) }, context);
		states.length = 0;
		await closing?.close(context);
		expect(states).toEqual(["ended", "ended"]);
	});

	it("opens a child under an ended parent, and the parent stays ended", async () => {
		const parent = await library.open(place, owner, "t:ended-parent", { root: "test", ...faux }, context);
		await parent.close(context);
		const child = await library.open(place, owner, "t:late", { parent: String(parent.id), ...faux }, context);
		expect(await library.find(place, owner, { key: "t:late" }, context)).toMatchObject({ id: child.id });
		expect(await parent.state(context)).toBe("ended");
		expect(await child.state(context)).toBe("idle");
	});

	it("a send stops a running schema ask", async () => {
		const child = await library.open(place, owner, "t:stop", { root: "test", ...faux, cwd: root }, context);
		const gate = Promise.withResolvers<void>();
		gates.set("Schema", gate);
		const before = called("Schema");
		const asked = child.ask({ type: "input", content: "Schema", requestId: "r1" }, context, { schema });
		await until(() => called("Schema") === before + 1);
		await child.send({ type: "input", content: "Plain", whenBusy: "followUp", requestId: "r2" }, context);
		gate.resolve();
		gates.delete("Schema");
		expect(await asked).toMatchObject({ status: "failed", reason: "no-respond" });
	});

	it("starts a new depth budget at depth 0 for a depth root, under its tree parent", async () => {
		const tree = await library.open(place, owner, "t:budget-tree", { root: "test", ...faux }, context);
		const sessionSpec: Spec = { parent: String(tree.id), ...faux, depthRoot: true };
		const session = await library.open(place, owner, "t:budget-session", sessionSpec, context);
		expect(session.lineage).toEqual({
			key: "t:budget-session",
			root: "test",
			parent: String(tree.id),
			depth: 0,
			limit: 2,
		});

		const child = await library.open(place, owner, "t:budget-child", { parent: String(session.id), ...faux }, context);
		expect(child.lineage).toMatchObject({ depth: 1, limit: 2 });
		const leafSpec = { parent: String(child.id), ...faux, cwd: root };
		const leaf = await library.open(place, owner, "t:budget-leaf", leafSpec, context);
		expect(leaf.lineage).toMatchObject({ depth: 2, limit: 2 });
		await leaf.ask({ type: "input", content: "Budget leaf", requestId: "r1" }, context);
		const tools = requests.get("Budget leaf")?.tools;
		expect(tools?.filter((name) => [...DELEGATION, "lookup"].includes(name))).toEqual(["lookup"]);
		await expect(
			library.open(place, owner, "t:budget-deeper", { parent: String(leaf.id), ...faux }, context),
		).rejects.toThrow("Nested subagents are disabled");

		// A depth root under a leaf of the tree starts a budget with its own limit.
		const ownSpec: Spec = { parent: String(leaf.id), ...faux, depthRoot: true, limit: 3 };
		const own = await library.open(place, owner, "t:budget-own", ownSpec, context);
		expect(own.lineage).toMatchObject({ depth: 0, limit: 3 });

		// The depth roots stay in the tree, so closing the tree closes them.
		expect(await tree.close(context)).toEqual([tree.id, session.id, child.id, leaf.id, own.id]);
	});

	it("takes the depth budget of the depth parent, and depth 1 for a conversation that the library did not open", async () => {
		const budget = await library.open(place, owner, "t:dp-budget", { root: "test", ...faux, limit: 3 }, context);
		const tree = await library.open(place, owner, "t:dp-tree", { root: "other", ...faux, limit: 5 }, context);
		const spec = { parent: String(tree.id), depthParent: String(budget.id), ...faux, limit: 9 };
		const child = await library.open(place, owner, "t:dp-child", spec, context);
		expect(child.lineage).toEqual({ key: "t:dp-child", root: "other", parent: String(tree.id), depth: 2, limit: 3 });
		expect((await tree.close(context)).includes(child.id)).toBe(true);
		const outside = String((await harness.root(context)).id);
		const fromRoot = { root: "test", depthParent: outside, ...faux, limit: 4 };
		expect((await library.open(place, owner, "t:dp-outside", fromRoot, context)).lineage).toMatchObject({
			depth: 1,
			limit: 4,
		});
		const fromText = { root: "test", depthParent: "pi-session", ...faux };
		expect((await library.open(place, owner, "t:dp-text", fromText, context)).lineage).toMatchObject({
			depth: 1,
			limit: 2,
		});
		const leaf = await library.open(place, owner, "t:dp-leaf", { root: "test", ...faux, limit: 1 }, context);
		await expect(
			library.open(place, owner, "t:dp-deeper", { root: "test", depthParent: String(leaf.id), ...faux }, context),
		).rejects.toThrow("Nested subagents are disabled");
	});

	it("gives a child at its depth limit no subagent and no workflow tool, also when Spec.tools names them", async () => {
		const offered = async (key: string, spec: Spec, prompt: string) => {
			const child = await library.open(place, owner, key, spec, context);
			await child.ask({ type: "input", content: prompt, requestId: "r1" }, context);

			return requests.get(prompt)?.tools.filter((name) => [...DELEGATION, "lookup"].includes(name));
		};

		const middle = await library.open(place, owner, "t:leaf-middle", { root: "test", ...faux, cwd: root }, context);
		expect(await offered("t:leaf-top", { root: "test", ...faux, cwd: root }, "Leaf top")).toEqual([
			...DELEGATION,
			"lookup",
		]);
		const parent = String(middle.id);
		expect(await offered("t:leaf", { parent, ...faux, cwd: root }, "Leaf plain")).toEqual(["lookup"]);
		const named = { parent, ...faux, cwd: root, tools: ["lookup", "subagent"] };
		expect(await offered("t:leaf-named", named, "Leaf named")).toEqual(["lookup"]);
		const rootLeaf = { root: "test", ...faux, cwd: root, depthRoot: true, limit: 0 } as const;
		expect(await offered("t:leaf-root", rootLeaf, "Leaf root")).toEqual(["lookup"]);
	});
});
