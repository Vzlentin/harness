import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type Host, runHost } from "../src/host/run.ts";
import { MAIN_PROJECT, projectDir } from "../src/protocol/projects.ts";
import { cellResults, cli, handleOf, models, requests, scripts, setUp, tearDown } from "./helpers.ts";

const DEFAULT_LINE = "Command stopped after 1 seconds: it set no timeout. Set a timeout to run longer.";

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await runHost({ project: MAIN_PROJECT, cwd: projectDir(MAIN_PROJECT), models, bashTimeoutSeconds: 1 });
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

/** Runs a child whose model makes the calls of `calls`, and gives the text of each tool result. */
async function run(prompt: string, calls: Parameters<typeof scripts.set>[1]): Promise<readonly string[]> {
	scripts.set(`Task:\n${prompt}`, calls);
	await cli(["wait", handleOf(await cli(["spawn", "--prompt", prompt]))]);

	return cellResults.get(`Task:\n${prompt}`) ?? [];
}

describe("the default timeout of a hosted bash call", { timeout: 30_000 }, () => {
	it("stops a call that sets no timeout after the default, with a line that asks for a timeout", async () => {
		const [result] = await run("No timeout", [
			{ name: "bash", arguments: { command: "echo started; sleep 30; echo finished" } },
		]);

		expect(result).toContain("started");
		expect(result).toContain(DEFAULT_LINE);
		expect(result).not.toContain("finished");
	});

	it("runs a call with the timeout that the model sets, also over the default", async () => {
		const [result] = await run("Long timeout", [
			{ name: "bash", arguments: { command: "sleep 2; echo done", timeout: 4 } },
		]);

		expect(result).toContain("done");
	});

	it("gives the timeout line of bash when the timeout of the model fires", async () => {
		const [result] = await run("Model timeout", [
			{ name: "bash", arguments: { command: "echo x; sleep 30", timeout: 1.5 } },
		]);

		expect(result).toContain("Command timed out after 1.5 seconds");
		expect(result).not.toContain("Command stopped after");
	});

	it("states the default in the declaration of bash", async () => {
		await run("Declaration", []);
		const seen = requests.get("Task:\nDeclaration");
		const bash = seen?.declarations.find(({ name }) => name === "bash");

		expect(JSON.stringify(bash?.parameters)).toContain("Timeout in seconds (optional, default 1 seconds)");
		expect(JSON.stringify(seen?.declarations)).not.toContain("no default timeout");
		expect(seen?.system).toContain("codemode");
		expect(seen?.system).not.toContain("no default timeout");
	});

	it("gives the default to a bash call of a codemode script", async () => {
		const code = 'try { await tools.bash({ command: "sleep 30" }); return "ran"; } catch (e) { return e.message; }';
		const [result] = await run("Codemode default", [{ name: "codemode", arguments: { code } }]);

		expect(result).toContain(DEFAULT_LINE);
	});
});
