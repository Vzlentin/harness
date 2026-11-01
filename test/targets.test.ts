import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { type ConversationId, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Owner, Place } from "../src/children.ts";
import { Push } from "../src/push.ts";
import { type ChildRecord, Children, library, markRead } from "../src/targets.ts";
import { models, root, setUp, tearDown } from "./helpers.ts";

const faux = { provider: "faux", model: "faux-1" } as const;

let harness: Harness;
let place: Place;
let owner: Extract<Owner, { kind: "detached" }>;

beforeAll(async () => {
	await setUp();
	const registry = durable.createRegistry();
	registry.install(library.extension);
	registry.install(library.answerExtension);
	harness = await Harness.open(
		await openNodeSqliteStorage(join(root, "targets.sqlite")),
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

/** Writes the record of `handle` in the `Children` document. */
async function putRecord(handle: string, record: ChildRecord): Promise<void> {
	await harness.commit(async (tx) => {
		(await tx.doc(Children)).children[handle] = record;
	}, context);
}

async function recordOf(handle: string): Promise<ChildRecord | undefined> {
	return (await harness.snapshot(Children, context))?.children[handle];
}

describe("read marks", () => {
	it("keeps read within sent, and pushed to a request of sent or a push input", async () => {
		// SAFETY: the marks do not look up the conversation of the record.
		const conversationId = 999 as ConversationId;
		await putRecord("marks", { caller: "cli", createdAt: "", conversationId, sent: ["spawn:a"] });
		await markRead(harness, "marks", 3, "mirror-input");
		expect(await recordOf("marks")).toMatchObject({ read: 1 });
		expect((await recordOf("marks"))?.pushed).toBeUndefined();
		await markRead(harness, "marks", 1, "push:other:2");
		expect(await recordOf("marks")).toMatchObject({ read: 1, pushed: "push:other:2" });
		await markRead(harness, "marks", 1, "spawn:a");
		expect(await recordOf("marks")).toMatchObject({ read: 1, pushed: "spawn:a" });
	});
});

describe("push", () => {
	it("wakes a wait for a held child when it closes, and the wait fails", async () => {
		const child = await library.open(place, owner, "t:held", { root: "test", ...faux, cwd: root }, context);
		// A child of `child` with an unread answer holds it.
		const holder = await library.open(place, owner, "t:holder", { root: "test", ...faux, cwd: root }, context);

		await putRecord("holder", {
			caller: String(child.id),
			createdAt: "",
			conversationId: holder.id,
			sent: ["never"],
		});

		const push = new Push({
			harness,
			place,
			owner,
			root: owner.root,
			project: "main",
			agent: async () => owner.root,
			warn: () => {},
		});

		const done = push.done(child, new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 200));
		push.close();
		const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting")), 2_000));
		await expect(Promise.race([done, timeout])).rejects.toThrow("The host is closing");
	});
});
