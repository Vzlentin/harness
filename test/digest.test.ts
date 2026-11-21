import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Degraded } from "../src/host/degraded.ts";
import { writeDigest } from "../src/host/digest.ts";
import { holdAction } from "../src/host/project.ts";
import { DigestReply } from "../src/protocol/project.ts";
import { errorMessage } from "../src/protocol/requests.ts";
import { models, projectHost, root, send, setUp, tearDown } from "./helpers.ts";

beforeAll(setUp);

afterAll(tearDown);

/** The digest text of `caller` in `project`, or `undefined` when it did not change. */
async function digestOf(project: string, caller: string): Promise<string | undefined> {
	return Value.Parse(DigestReply, await send({ type: "digest", caller }, project)).text;
}

/** Adds the open item `title` to `project` as the CLI. */
async function addItem(project: string, title: string): Promise<void> {
	await send({ type: "item", action: "add", caller: "cli", title }, project);
}

describe("the digest", () => {
	it("keeps a failed write as a degraded state, with its warning, until a digest of the conversation is written", async () => {
		const storage = await openNodeSqliteStorage(join(await mkdtemp(join(root, "digest-")), "store.sqlite"));
		const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);

		try {
			const conversation = await harness.root(BACKGROUND_CONTEXT);
			const agent = String(conversation.id);
			const call = { requestId: "call-1", agent, tool: "bash", command: "git push", reason: "No go." };
			await harness.commit((tx) => holdAction(tx, call), BACKGROUND_CONTEXT);
			const warnings: string[] = [];
			const degraded = new Degraded((cause) => warnings.push(errorMessage(cause)));
			const host = { harness, storage, project: "digest-failed", degraded };

			const failing = async () => {
				throw new Error("Write failed");
			};

			await writeDigest(host, { conversation, write: failing });
			expect(warnings).toEqual(["digest: Write failed"]);
			expect(host.degraded.list()).toEqual([
				{ kind: "digest-failed", line: "digest: Write failed", since: expect.any(Number) },
			]);

			const written: unknown[] = [];
			await writeDigest(host, { conversation, write: async (write) => void written.push(write) });
			expect(written).toEqual([
				expect.objectContaining({
					entry: expect.objectContaining({ data: { waits: [], held: [1], items: [] } }),
				}),
			]);
			expect(host.degraded.list()).toEqual([]);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("shows the open items that need no open item, and gives a new digest when the board changes", async () => {
		const project = "digest-board";
		const host = await projectHost(project);

		try {
			for (const title of ["Scope", "Build", "Ship"]) await addItem(project, title);
			const link = { type: "item", action: "link", caller: "cli", kind: "needs" } as const;
			await send({ ...link, from: "item:2", to: "item:1" }, project);
			await send({ ...link, from: "item:3", to: "item:2" }, project);

			const tail = "waiting on: none\nheld: none";
			expect(await digestOf(project, "pi-1")).toBe(`board of ${project}: 3 open\n○ 1 Scope\n+2 later\n${tail}`);
			expect(await digestOf(project, "pi-1")).toBeUndefined();

			// A closed need moves its item up, and the closed item leaves the board.
			await send({ type: "item", action: "set", caller: "cli", id: 1, state: "done" }, project);
			expect(await digestOf(project, "pi-1")).toBe(`board of ${project}: 2 open\n○ 2 Build\n+1 later\n${tail}`);

			await addItem(project, "Docs");
			expect(await digestOf(project, "pi-1")).toBe(
				`board of ${project}: 3 open\n○ 2 Build\n○ 4 Docs\n+1 later\n${tail}`,
			);
		} finally {
			await host.close();
		}
	});

	it("shows at most 10 items, and counts the others as later", async () => {
		const project = "digest-cap";
		const host = await projectHost(project);

		try {
			for (let n = 1; n <= 11; n++) await addItem(project, `Work ${n}`);
			const shown = Array.from({ length: 10 }, (_, index) => `○ ${index + 1} Work ${index + 1}`);

			expect(await digestOf(project, "pi-1")).toBe(
				[`board of ${project}: 11 open`, ...shown, "+1 later", "waiting on: none", "held: none"].join("\n"),
			);
		} finally {
			await host.close();
		}
	});
});
