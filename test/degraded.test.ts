import { describe, expect, it } from "vite-plus/test";
import { Degraded } from "../src/host/degraded.ts";

describe("the degraded states of a host", () => {
	it("keeps the start of a state that continues, sorts by start then kind, and calls its listeners only on a change", () => {
		let now = 1_000;
		const quiet = () => undefined;
		const degraded = new Degraded(quiet, () => now);

		let changes = 0;
		const stop = degraded.subscribe(() => (changes += 1));

		degraded.start("push-failed", "a1", "The push of a1 failed: gone");
		now = 2_000;
		degraded.start("digest-failed", "7", "digest: Write failed");
		degraded.start("approve-tell", "3", "The tell of approved action 3 failed: gone");
		expect(changes).toBe(3);

		// The same line again changes nothing; a new line keeps the start.
		now = 3_000;
		degraded.start("push-failed", "a1", "The push of a1 failed: gone");
		expect(changes).toBe(3);
		degraded.start("push-failed", "a1", "The push of a1 failed: closed");
		expect(changes).toBe(4);

		expect(degraded.list()).toEqual([
			{ kind: "push-failed", line: "The push of a1 failed: closed", since: 1_000 },
			{ kind: "approve-tell", line: "The tell of approved action 3 failed: gone", since: 2_000 },
			{ kind: "digest-failed", line: "digest: Write failed", since: 2_000 },
		]);

		// An end of a state that is not there changes nothing; the same cause of another kind is another state.
		degraded.end("push-failed", "b2");
		degraded.end("digest-failed", "a1");
		expect(changes).toBe(4);
		degraded.end("push-failed", "a1");
		expect(changes).toBe(5);
		expect(degraded.list().map(({ kind }) => kind)).toEqual(["approve-tell", "digest-failed"]);

		stop();
		degraded.end("digest-failed", "7");
		expect(changes).toBe(5);
		expect(degraded.list().map(({ kind }) => kind)).toEqual(["approve-tell"]);
	});

	it("ends only the states of a kind whose cause is not kept", () => {
		const degraded = new Degraded(
			() => undefined,
			() => 1_000,
		);

		let changes = 0;
		degraded.start("answer-waits", "a", "A waits");
		degraded.start("answer-waits", "b", "B waits");
		degraded.start("push-failed", "c", "C failed");
		degraded.subscribe(() => (changes += 1));

		degraded.keepOnly("answer-waits", new Set(["a", "b", "c"]));
		expect(changes).toBe(0);
		degraded.keepOnly("answer-waits", new Set(["a", "c"]));
		expect(changes).toBe(1);
		expect(degraded.list().map(({ line }) => line)).toEqual(["A waits", "C failed"]);
	});

	it("guards a run: a failure warns, starts the state and gives undefined, and a success ends it", async () => {
		const warnings: string[] = [];

		const degraded = new Degraded(
			(cause) => warnings.push(String(cause)),
			() => 1_000,
		);

		const failed = await degraded.guard("digest-failed", "7", "digest: ", () => Promise.reject(new Error("gone")));
		expect(failed).toBeUndefined();
		expect(warnings).toEqual(["Error: digest: gone"]);
		expect(degraded.list()).toEqual([{ kind: "digest-failed", line: "digest: gone", since: 1_000 }]);

		expect(await degraded.guard("digest-failed", "7", "digest: ", () => Promise.resolve(3))).toBe(3);
		expect(degraded.list()).toEqual([]);
	});
});
