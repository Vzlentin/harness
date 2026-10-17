import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REMINDER } from "../src/answer.ts";
import { createChildren, type Owner, type Place } from "../src/children.ts";
import { called, gates, models, root, SCHEMA_ANSWER, setUp, tearDown, until } from "./helpers.ts";

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
			await runtime.sleep(runtime.now() + 3_600_000, taskContext);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext);
		},
	},
	abort: (_task, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

beforeAll(async () => {
	await setUp();
	const registry = durable.createRegistry();
	registry.install(library.extension);
	registry.install(library.answerExtension);
	registry.install(durable.defineExtension({ name: "test-holder", tasks: [Holder] }));
	harness = await Harness.open(
		await openNodeSqliteStorage(join(root, "children.sqlite")),
		{ models, registry },
		context,
	);
	harness.resume();
	place = { store: harness, models, registry: registry.snapshot() };
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

	it("refuses a spec without a model when the owner's agent has none, and an unknown model", async () => {
		await expect(library.open(place, owner, "t:none", { root: "test" }, context)).rejects.toThrow(
			"No model: neither the spec nor the owner's agent names one",
		);
		await expect(
			library.open(place, owner, "t:unknown", { root: "test", provider: "faux", model: "nope" }, context),
		).rejects.toThrow("Unknown model: faux/nope");
		expect(await library.find(place, owner, { key: "t:none" }, context)).toBeUndefined();
	});

	it("answers a request, sums the spend of the subtree and closes the subtree", async () => {
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
		expect(await child.state(context)).toBe("closed");
	});

	it("refuses a child of another owner", async () => {
		const child = await library.open(place, owner, "t:mine", { root: "test", ...faux }, context);
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
		const ownerOf = (taskId: TaskId, group?: string): Owner => ({
			kind: "task",
			taskId,
			conversation: rootConversation.id,
			...(group === undefined ? {} : { group }),
		});
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
		await harness.abortTask(second, context);
	});

	it("closes only the subtree under a child with below, and the child stays open", async () => {
		const parent = await library.open(place, owner, "t:below", { root: "test", ...faux, cwd: root }, context);
		const child = await library.open(place, owner, "t:below-child", { parent: String(parent.id), ...faux }, context);
		expect(await parent.close(context, { below: true })).toEqual([child.id]);
		expect(await child.state(context)).toBe("closed");
		expect(await parent.state(context)).toBe("idle");
		expect(await parent.ask({ type: "input", content: "Still open", requestId: "r1" }, context)).toMatchObject({
			status: "ok",
			text: "Answer to Still open",
		});
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

	it("withdraws queued input when it closes a child", async () => {
		const child = await library.open(place, owner, "t:queue", { root: "test", ...faux, cwd: root }, context);
		gates.set("Busy", Promise.withResolvers());
		await child.send({ type: "input", content: "Busy", requestId: "r1" }, context);
		await until(() => called("Busy") === 1);
		await child.send({ type: "input", content: "Queued", whenBusy: "followUp", requestId: "r2" }, context);
		await child.close(context);
		expect(await child.settled(context, "r2")).toMatchObject({ status: "failed", reason: "unanswered" });
		expect(called("Queued")).toBe(0);
		await expect(child.send({ type: "input", content: "Revived", requestId: "r3" }, context)).rejects.toThrow(
			`The child ${child.id} is closed`,
		);
		expect(await child.state(context)).toBe("closed");
		expect(called("Revived")).toBe(0);
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
});
