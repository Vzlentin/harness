import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChildren, type Owner, type Place } from "../src/children.ts";
import { models, root, setUp, tearDown } from "./helpers.ts";

const library = createChildren(durable);
const faux = { provider: "faux", model: "faux-1" } as const;
let harness: Harness;
let place: Place;
let owner: Owner;

beforeAll(async () => {
	await setUp();
	const registry = durable.createRegistry();
	registry.install(library.extension);
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
});
