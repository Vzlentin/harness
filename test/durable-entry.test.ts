import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/** A resolve hook that fails each import of an `@earendil-works/` package. Type imports are stripped, so they pass. */
const hook = `export async function resolve(s, c, n) {
	if (s.startsWith("@earendil-works/")) throw new Error("runtime import of " + s + " from " + c.parentURL);
	return n(s, c);
}`;

/** Registers the hook given as the first argument, imports the module given as the second and prints its export names. */
const script = `import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(process.argv[1]));
const m = await import(process.argv[2]);
console.log(JSON.stringify(Object.keys(m)));`;

describe("the durable entry", () => {
	it("loads with no runtime import of a package that the host passes", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "harness-durable-entry-"));

		try {
			const entryUrl = new URL("../src/host/durable-entry.ts", import.meta.url).href;

			const { stdout } = await run(
				process.execPath,
				["--no-deprecation", "--input-type=module", "-e", script, hook, entryUrl],
				{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
			);

			expect(stdout.trim()).toBe('["default"]');
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
