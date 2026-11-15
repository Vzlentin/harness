import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { MAX_QUERY, QUERY_CUT_LINE } from "../src/protocol/query.ts";
import {
	answerOf,
	calls,
	cli,
	handleOf,
	openWatch,
	QUERIED,
	QUERIED_CALL,
	setSettings,
	setUp,
	spawnAs,
	spawnWithId,
	startHost,
	tearDown,
} from "./helpers.ts";

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	await setSettings({ queryModel: "faux/faux-2" });
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

/** The transcript that the query model got in the answer `answer`, which the faux model gives as `Answer to <prompt>`. */
function transcriptOf(answer: string): string {
	return /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(answer)?.[1] ?? "";
}

describe("query", { timeout: 30_000 }, () => {
	it("answers with the messages and the tool calls of an own child, and no thinking and no tool output", async () => {
		const child = await spawnAs("a", QUERIED, { notify: false });
		expect(await answerOf(child.handle)).toBe("Listed the files");

		const result = await cli(["query", child.handle, "What did it do?"], { PI_SESSION_ID: "a" });
		expect(result.stderr).toBe("");
		expect(result.stdout.startsWith("Answer to <transcript>\n")).toBe(true);
		expect(result.stdout.endsWith("\n\nQuestion: What did it do?\n")).toBe(true);
		expect(transcriptOf(result.stdout)).toBe(
			[
				`User: ${QUERIED}`,
				"Assistant: I list the files",
				`Tool call bash: ${JSON.stringify(QUERIED_CALL)}`,
				"Assistant: Listed the files",
			].join("\n\n"),
		);
		expect(result.stdout).not.toContain("Secret thinking");
		expect(result.stdout).not.toContain("421234");
		expect(calls.at(-1)).toMatchObject({ provider: "faux", model: "faux-2" });
	});

	it("refuses a child of another caller, and lets a terminal that is not an agent query it", async () => {
		const child = await spawnAs("a", "Mine", { notify: false });
		await answerOf(child.handle);

		expect((await cli(["query", child.handle, "Why?"], { PI_SESSION_ID: "b" })).stderr).toBe(
			`Subagent ${child.handle} belongs to another session\n`,
		);
		expect(transcriptOf((await cli(["query", child.handle, "Why?"])).stdout)).toBe(
			"User: Mine\n\nAssistant: Answer to Mine",
		);
		expect((await cli(["query", "agent", "Why?"], { PI_SESSION_ID: "a" })).stderr).toBe(
			"Only a terminal that is not an agent can query the project agent\n",
		);
	});

	it("answers the agent that stopped its own child, by handle and by conversation ID", async () => {
		const { handle, id } = await spawnWithId("c");
		const env = { PI_SESSION_ID: "c" };

		expect((await cli(["stop", handle], env)).stderr).toBe("");
		expect(transcriptOf((await cli(["query", handle, "Why?"], env)).stdout)).toContain("Tool call bash:");
		expect(transcriptOf((await cli(["query", "--conversation", id, "Why?"], env)).stdout)).toContain("Tool call bash:");
	});

	it("reaches a conversation by its ID, also when it is ended", async () => {
		const { handle, id } = await spawnWithId("a");
		const ask = (env: NodeJS.ProcessEnv = {}) => cli(["query", "--conversation", id, "What ran?"], env);

		expect(transcriptOf((await ask()).stdout)).toContain("Tool call bash:");
		expect(transcriptOf((await ask({ PI_SESSION_ID: "a" })).stdout)).toContain("Tool call bash:");
		expect((await ask({ PI_SESSION_ID: "b" })).stderr).toBe(`The conversation ${id} is not a child of this caller\n`);

		expect((await cli(["stop", handle], { PI_SESSION_ID: "a" })).stderr).toBe("");
		const ended = await ask();
		expect(ended.stderr).toBe("");
		expect(transcriptOf(ended.stdout)).toContain("Tool call bash:");
	});

	it("reads the last part of a conversation over the bound, and says so in the first line", async () => {
		// Two prompts and their answers pass the bound together. The wide model does not compact them. Linux refuses an
		// argument of 128 KiB or more, so each prompt stays under it.
		const big = `Big start ${"x".repeat(MAX_QUERY.bytes / 4 + 10_000)}`;
		const env = { PI_SESSION_ID: "a" };
		const handle = handleOf(await cli(["spawn", "--model", "faux-wide", "--prompt", big], env));
		await answerOf(handle);
		await cli(["send", handle, big], env);
		await answerOf(handle);
		await cli(["send", handle, "Last words"], env);
		await answerOf(handle);

		const answer = (await cli(["query", handle, "What came last?"])).stdout;
		expect(answer.startsWith(`${QUERY_CUT_LINE}\nAnswer to <transcript>\n`)).toBe(true);
		const transcript = transcriptOf(answer);
		expect(transcript.endsWith("User: Last words\n\nAssistant: Answer to Last words")).toBe(true);
		expect(transcript).not.toContain("User: Task:\nBig start");
		expect(Buffer.byteLength(transcript, "utf8")).toBe(MAX_QUERY.bytes);
	});

	it("leaves the entries of the conversation as they were", async () => {
		const child = await spawnAs("a", "Unchanged", { notify: false });
		await answerOf(child.handle);
		const before = await openWatch({ kind: "child", handle: child.handle });

		try {
			await cli(["query", child.handle, "Anything?"]);
			const after = await openWatch({ kind: "child", handle: child.handle });
			after.client.close();
			expect(after.view.entries).toEqual(before.view.entries);
			expect(after.child.state).toBe("idle");
			expect(before.lines).toEqual([]);
		} finally {
			before.client.close();
		}
	});

	it("takes subagentModel without queryModel, and fails with one line for an unknown model", async () => {
		const child = await spawnAs("a", "Models", { notify: false });
		await answerOf(child.handle);

		try {
			await setSettings({ subagentModel: "faux/faux-1" });
			expect((await cli(["query", child.handle, "Which?"])).stderr).toBe("");
			expect(calls.at(-1)).toMatchObject({ provider: "faux", model: "faux-1" });

			await setSettings({ queryModel: "faux/nope" });
			expect((await cli(["query", child.handle, "Which?"])).stderr).toBe("Unknown model: faux/nope\n");

			await setSettings();
			expect((await cli(["query", child.handle, "Which?"])).stderr).toBe(
				"No model for a query: set queryModel, subagentModel or a default model in Pi\n",
			);
		} finally {
			await setSettings({ queryModel: "faux/faux-2" });
		}
	});
});
