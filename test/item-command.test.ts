import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { cli, setUp, startHost, tearDown } from "./helpers.ts";

const USAGE_LINE = "  harness item [list [--state <state>]]\n";

const RUN = "run:20261120T172928-841433af";

let host: Host | undefined;

/** The output of `harness item <args>`, which must succeed. */
async function item(args: readonly string[]): Promise<string> {
	const result = await cli(["item", ...args]);
	expect(result).toMatchObject({ code: 0, stderr: "" });

	return result.stdout;
}

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("harness item", { timeout: 30_000 }, () => {
	it("adds, sets, lists, shows and links the work items of the project", async () => {
		expect(await item([])).toBe("No items\n");
		expect(await item(["add", "Move", "the", "config", "--text", "Into vite.config.ts."])).toBe(
			"○ 1 inbox Move the config\n",
		);
		expect(await item(["add", "Drop the flag"])).toBe("○ 2 inbox Drop the flag\n");
		expect(await item(["set", "1", "--title", "Move the config file"])).toBe("○ 1 inbox Move the config file\n");
		expect(await item(["link", RUN, "serves", "item:1"])).toBe(`${RUN} serves item:1\n`);
		expect(await item(["show", "1"])).toBe(
			`○ 1 inbox Move the config file\nInto vite.config.ts.\n${RUN} serves item:1\n`,
		);
		expect(await item(["show", "2"])).toBe("○ 2 inbox Drop the flag\n");
		expect(await item(["set", "2", "dropped", "--text", "Not needed."])).toBe("✗ 2 dropped Drop the flag\n");
		expect(await item(["list"])).toBe("○ 1 inbox Move the config file\n");
		expect(await item(["list", "--state", "dropped"])).toBe("✗ 2 dropped Drop the flag\n");
		expect(await item(["show", "2"])).toBe("✗ 2 dropped Drop the flag\nNot needed.\n");
	});

	it("refuses bad arguments before any request, and prints the usage for other words", async () => {
		const cases: [string[], string][] = [
			[["show", "0"], "Invalid item id: 0\n"],
			[["set", "1.5", "done"], "Invalid item id: 1.5\n"],
			[["set", "1", "finished"], "Invalid item state: finished\n"],
			[["list", "--state", "doing"], "Invalid item state: doing\n"],
			[["link", RUN, "builds", "item:1"], "Invalid edge kind: builds\n"],
			[["link", "run:nope", "serves", "item:1"], "Invalid item reference: run:nope\n"],
			[["link", RUN, "serves", "todo:1"], "Invalid item reference: todo:1\n"],
			[["list", "--verbose"], "Unknown item argument: --verbose\n"],
			[["add", "x", "--text", "a", "--text", "b"], "Unknown item argument: --text\n"],
			[["add", "x", "--text"], "--text requires a value\n"],
			[["show", "9"], "Unknown item: 9\n"],
		];

		const results = await Promise.all(cases.map(([args]) => cli(["item", ...args])));
		expect(results.map(({ code, stderr }) => ({ code, stderr }))).toEqual(
			cases.map(([, stderr]) => ({ code: 1, stderr })),
		);

		const usages = [
			["move"],
			["add"],
			["set"],
			["set", "1"],
			["set", "1", "done", "extra"],
			["show"],
			["show", "1", "2"],
			["link", RUN, "serves"],
			["list", "extra"],
			["list", "--title", "x"],
			["show", "1", "--text", "x"],
			["add", "x", "--state", "done"],
		];

		for (const args of usages) {
			const result = await cli(["item", ...args]);
			expect(result).toMatchObject({ code: 1, stdout: "" });
			expect(result.stderr).toMatch(/^Usage:/);
			expect(result.stderr).toContain(USAGE_LINE);
		}

		expect(await item(["show", "1"])).toBe(
			`○ 1 inbox Move the config file\nInto vite.config.ts.\n${RUN} serves item:1\n`,
		);
	});
});
