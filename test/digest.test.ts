import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Degraded } from "../src/host/degraded.ts";
import { writeDigest } from "../src/host/digest.ts";
import { holdAction } from "../src/host/project.ts";
import { errorMessage } from "../src/protocol/requests.ts";
import { openDurableHost, root, setUp, tearDown } from "./helpers.ts";

beforeAll(setUp);

afterAll(tearDown);

describe("the digest", () => {
	it("keeps a failed write as a degraded state, with its warning, until a digest of the conversation is written", async () => {
		const harness = await openDurableHost(join(await mkdtemp(join(root, "digest-")), "store.sqlite"), []);

		try {
			const conversation = await harness.root(BACKGROUND_CONTEXT);
			const agent = String(conversation.id);
			const call = { requestId: "call-1", agent, tool: "bash", command: "git push", reason: "No go." };
			await harness.commit((tx) => holdAction(tx, call), BACKGROUND_CONTEXT);
			const warnings: string[] = [];
			const host = { harness, degraded: new Degraded((cause) => warnings.push(errorMessage(cause))) };

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
			expect(written).toHaveLength(1);
			expect(host.degraded.list()).toEqual([]);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
