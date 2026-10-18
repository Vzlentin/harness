import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as ai from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import { AssistantEntry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createChildren } from "../src/children.ts";
import { type Client, connect, request } from "../src/client.ts";
import subagentEntry from "../src/durable-entry.ts";
import { type Host, runHost } from "../src/host.ts";
import { projectDir } from "../src/projects.ts";
import { AGENT_HANDLE, type ChildInfo, onLines, statePaths, type WatchLine } from "../src/protocol.ts";
import { subagentTool } from "../src/tool.ts";
import {
	called,
	calls,
	cli,
	gates,
	handleOf,
	models,
	requests,
	root,
	setUp,
	startHost,
	tearDown,
	textOf,
	toolWaits,
	until,
} from "./helpers.ts";

/** What the pi-durable test hosts report, such as a structured output that does not match the tool's schema. */
const reports: unknown[] = [];

/** A pi-durable host over `store` with the `piDurable` entry of this package. */
async function openDurable(store: string): Promise<Harness> {
	const entry = subagentEntry({ durable, ai });
	const registry = durable.createRegistry();

	for (const extension of entry.extensions) registry.install(extension);

	return Harness.open(
		await openNodeSqliteStorage(store),
		{ models, registry, onReport: (error) => reports.push(error) },
		BACKGROUND_CONTEXT,
	);
}

/**
 * A pi-durable host over `store` with the `subagent` tool, where the caller is `durable-test:<conversation ID>`. With
 * `hangSpawn`, a spawn reaches the harness host, but the tool call never finishes.
 */
async function openDurableTool(store: string, hangSpawn: boolean): Promise<Harness> {
	const registry = durable.createRegistry();
	registry.install(
		subagentTool(durable, ai, {
			caller: async (api) => `durable-test:${api.conversationId}`,
			send: async (message, signal) => {
				const reply = await request(message, { start: true, signal });

				if (!hangSpawn || message.type !== "spawn") return reply;

				return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
			},
		}),
	);

	return Harness.open(
		await openNodeSqliteStorage(store),
		{ models, registry, onReport: (error) => reports.push(error) },
		BACKGROUND_CONTEXT,
	);
}

/** An error reply of a host. */
const ErrorReply = Type.Object({ ok: Type.Literal(false), error: Type.String() });

/** The error of the main host's reply to one raw request line, which the typed client cannot send. */
function rawError(line: string): Promise<string> {
	const socket = createConnection(statePaths("main").socket);

	return new Promise((resolveError, rejectError) => {
		socket.once("error", rejectError);
		onLines(socket, (reply) => {
			socket.destroy();
			const parsed: unknown = JSON.parse(reply);

			if (Value.Check(ErrorReply, parsed)) resolveError(parsed.error);
			else rejectError(new Error(`Not an error reply: ${reply}`));
		});
		socket.write(`${line}\n`);
	});
}

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("subagent", { timeout: 30_000 }, () => {
	it("spawns, reports and waits for a child", async () => {
		const spawned = await cli(["spawn", "--name", "greeter", "--prompt", "Say hello"]);
		expect(spawned.stderr).toBe("");
		const handle = handleOf(spawned);
		expect(spawned.stdout).toBe(`Spawned greeter (${handle})\nState: busy\n`);

		const waited = await cli(["wait", handle]);
		expect(waited).toEqual({ code: 0, stdout: `${handle} finished\n\nAnswer to Task:\nSay hello\n`, stderr: "" });
		expect((await cli(["status", handle])).stdout).toBe(`greeter (${handle}): idle (faux/faux-1, medium)\n`);
		expect((await cli(["list"])).stdout).toContain(`greeter (${handle})  idle      faux/faux-1  medium\n`);
		expect(calls.find((call) => call.prompt === "Task:\nSay hello")).toEqual({
			provider: "faux",
			model: "faux-1",
			thinking: "medium",
			prompt: "Task:\nSay hello",
		});
	});

	it("passes the model, thinking level and files to the child", async () => {
		const file = join(root, "spec.md");
		await writeFile(file, "The spec.");

		const spawned = await cli([
			"spawn",
			"--provider",
			"faux",
			"--model",
			"faux-2",
			"--thinking",
			"high",
			"--file",
			file,
			"--prompt",
			"Read it",
		]);

		const handle = handleOf(spawned);
		const prompt = `<file name="${file}">\nThe spec.\n</file>\nTask:\nRead it`;
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to ${prompt}\n`);
		expect(calls.find((call) => call.prompt === prompt)).toEqual({
			provider: "faux",
			model: "faux-2",
			thinking: "high",
			prompt,
		});
		expect((await cli(["status", handle])).stdout).toBe(`${handle}: idle (faux/faux-2, high)\n`);
	});

	it("refuses unknown arguments, models and tools", async () => {
		expect((await cli(["spawn", "--no-skills", "--prompt", "x"])).stderr).toBe("Unknown spawn argument: --no-skills\n");
		expect((await cli(["spawn", "--model", "nope", "--prompt", "x"])).stderr).toBe("Unknown model: faux/nope\n");
		expect((await cli(["spawn", "--tools", "read,web", "--prompt", "x"])).stderr).toBe("Unknown tool: web\n");
		expect((await cli(["status", "abcdef"])).stderr).toBe("Unknown subagent: abcdef\n");
		expect((await cli(["spawn", "--thinking", "huge", "--prompt", "x"])).stderr).toBe("Invalid thinking level: huge\n");
		expect((await cli(["spawn", "--thinking", "xhigh", "--prompt", "x"])).stderr).toBe(
			"faux/faux-1 has no thinking level xhigh\n",
		);
		expect((await cli(["spawn", "--name", "x"])).stderr).toBe("spawn requires at least one prompt or file\n");
		expect((await cli(["status", "ABC"])).stderr).toBe("Invalid subagent handle: ABC\n");
	});

	it("gives a child the project instructions, skills, tools and directory, as a Pi session there", async () => {
		const project = join(root, "project");

		const skill = async (dir: string, name: string) => {
			await mkdir(join(dir, name), { recursive: true });
			await writeFile(
				join(dir, name, "SKILL.md"),
				`---\nname: ${name}\ndescription: The ${name} skill.\n---\nDo it.\n`,
			);
		};

		await mkdir(project);
		await writeFile(join(project, "AGENTS.md"), "Use tabs.");
		await skill(join(project, ".pi", "skills"), "local");
		await skill(join(root, "agent", "skills"), "greet");

		// No decision is saved with `/trust`, so the project skill stays out.
		await cli(["wait", handleOf(await cli(["spawn", "--cwd", project, "--prompt", "Context"]))]);
		const seen = requests.get("Task:\nContext");
		expect(seen?.system).toContain(
			`<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(project, "AGENTS.md")}">\nUse tabs.\n</project_instructions>\n</project_context>`,
		);
		expect(seen?.system).toContain("<name>greet</name>");
		expect(seen?.system).toContain("Use the read tool to load a skill's file");
		expect(seen?.system).not.toContain("<name>local</name>");
		expect(seen?.system).toContain(`<cwd>\n${project}\n</cwd>`);
		expect(seen?.tools).toEqual(["read", "grep", "find", "ls", "write", "edit", "bash", "subagent"]);

		// Once `/trust` saves the decision, the next request loads the project skill.
		new ProjectTrustStore(join(root, "agent")).set(project, true);
		await cli(["wait", handleOf(await cli(["spawn", "--cwd", project, "--prompt", "Trusted context"]))]);
		expect(requests.get("Task:\nTrusted context")?.system).toContain("<name>local</name>");

		// A child without `read` loads skills with bash.
		await cli(["wait", handleOf(await cli(["spawn", "--cwd", project, "--tools", "bash", "--prompt", "Bash only"]))]);
		expect(requests.get("Task:\nBash only")?.system).toContain("Use bash to load a skill's file");
		expect(requests.get("Task:\nBash only")?.tools).toEqual(["bash"]);
	});

	it("gives the child's bash its session ID, provider, model and thinking level", async () => {
		const handle = handleOf(await cli(["spawn", "--thinking", "low", "--prompt", "Environment"]));
		const { stdout } = await cli(["wait", handle]);
		expect(stdout).toMatch(new RegExp(`^${handle} finished\n\nTool said: \\d+ faux faux-1 low main\n`));
	});

	it("steers a busy child after its tool round", async () => {
		const cwd = await mkdtemp(join(root, "steer-"));
		const handle = handleOf(await cli(["spawn", "--cwd", cwd, "--prompt", "Use a tool"]));
		await until(() => called("Task:\nUse a tool") === 1);
		expect((await cli(["send", handle, "Focus on errors"])).stdout).toBe(`Steered ${handle}\n`);
		await writeFile(join(cwd, "go"), "");
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Focus on errors\n`);
		expect((await cli(["send", handle, "Again"])).stdout).toBe(`Prompted ${handle}\n`);
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Again\n`);
	});

	it("queues a follow-up, renames and stops a child", async () => {
		gates.set("Task:\nHold on", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Hold on"]));
		await until(() => called("Task:\nHold on") === 1);
		expect((await cli(["send", handle, "--follow-up", "Then summarize"])).stdout).toBe(
			`Queued follow-up for ${handle}\n`,
		);
		expect((await cli(["status", handle])).stdout).toBe(`${handle}: busy (faux/faux-1, medium)\n`);
		gates.get("Task:\nHold on")?.resolve();
		expect((await cli(["wait", handle])).stdout).toBe(
			`${handle} finished\n\n2 unread answers, oldest first.\n\n` +
				"--- Answer 1 of 2 ---\nAnswer to Task:\nHold on\n\n--- Answer 2 of 2 ---\nAnswer to Then summarize\n",
		);

		expect((await cli(["rename", handle, "summary"])).stdout).toBe(`Renamed summary (${handle})\n`);
		expect((await cli(["stop", handle])).stdout).toBe(`Stopped summary (${handle})\n`);
		expect((await cli(["status", handle])).stderr).toBe(`Unknown subagent: ${handle}\n`);
	});

	it("gives an answer that no wait read with the answer to the next message", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "First"]));

		while ((await cli(["status", handle])).stdout !== `${handle}: idle (faux/faux-1, medium)\n`) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		expect((await cli(["send", handle, "Second"])).stdout).toBe(`Prompted ${handle}\n`);
		expect((await cli(["wait", handle])).stdout).toBe(
			`${handle} finished\n\n2 unread answers, oldest first.\n\n` +
				"--- Answer 1 of 2 ---\nAnswer to Task:\nFirst\n\n--- Answer 2 of 2 ---\nAnswer to Second\n",
		);
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Second\n`);
	});

	it("keeps a message sent during a wait unread for the next wait", async () => {
		gates.set("Task:\nSlow", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Slow"]));
		await until(() => called("Task:\nSlow") === 1);
		const waiting = cli(["wait", handle]);
		// The wait has read the last request before the follow-up comes.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await cli(["send", handle, "--follow-up", "Late"])).stdout).toBe(`Queued follow-up for ${handle}\n`);
		gates.get("Task:\nSlow")?.resolve();
		expect((await waiting).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nSlow\n`);
		await until(() => called("Late") === 1);

		while ((await cli(["status", handle])).stdout !== `${handle}: idle (faux/faux-1, medium)\n`) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		expect((await cli(["send", handle, "After"])).stdout).toBe(`Prompted ${handle}\n`);
		expect((await cli(["wait", handle])).stdout).toBe(
			`${handle} finished\n\n2 unread answers, oldest first.\n\n` +
				"--- Answer 1 of 2 ---\nAnswer to Late\n\n--- Answer 2 of 2 ---\nAnswer to After\n",
		);
	});

	it("gives an earlier failed turn as an unread answer", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Fail"]));

		while ((await cli(["status", handle])).stdout !== `${handle}: error (faux/faux-1, medium)\n`) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		expect((await cli(["send", handle, "Again"])).stdout).toBe(`Prompted ${handle}\n`);
		expect((await cli(["wait", handle])).stdout).toBe(
			`${handle} finished\n\n2 unread answers, oldest first.\n\n` +
				`--- Answer 1 of 2 ---\n(no answer: ${handle} failed: overloaded)\n\n--- Answer 2 of 2 ---\nAnswer to Again\n`,
		);
	});

	it("stops a busy child", async () => {
		gates.set("Task:\nNever", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Never"]));
		await until(() => called("Task:\nNever") === 1);
		expect((await cli(["stop", handle])).stdout).toBe(`Stopped ${handle}\n`);
		expect((await cli(["list"])).stdout).not.toContain(handle);
	});

	it("reports a failed turn as an error", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Fail"]));
		const waited = await cli(["wait", handle]);
		expect(waited.code).toBe(1);
		expect(waited.stderr).toBe(`${handle} failed: overloaded\n`);
		expect((await cli(["status", handle])).stdout).toBe(`${handle}: error (faux/faux-1, medium)\n`);
	});

	it("times out a wait", async () => {
		gates.set("Task:\nSlow", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Slow"]));
		expect((await cli(["wait", handle, "--timeout", "1"])).stderr).toBe(`Timed out after 1s waiting for ${handle}\n`);
		gates.get("Task:\nSlow")?.resolve();
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nSlow\n`);
	});

	it("keeps each caller's children apart", async () => {
		const other = { PI_SESSION_ID: "other-session" };
		gates.set("Task:\nMine", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--name", "mine", "--prompt", "Mine"], other));
		expect((await cli(["list"], other)).stdout).toBe(`mine (${handle})  busy      faux/faux-1  medium\n`);
		expect((await cli(["list"], { PI_SESSION_ID: "third" })).stdout).toBe("No subagents\n");
		expect((await cli(["send", handle, "Hi"])).stderr).toBe(`Subagent ${handle} belongs to another session\n`);
		expect((await cli(["stop", handle])).stderr).toBe(`Subagent ${handle} belongs to another session\n`);
		gates.get("Task:\nMine")?.resolve();
		expect((await cli(["wait", handle], other)).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nMine\n`);
		// The viewer may send to the child of any caller.
		const viewer = { type: "input", requestId: "viewer-input", handle, message: "From viewer" } as const;
		const sent = await request({ ...viewer, followUp: false }, { start: false });
		expect(sent?.verb).toBe("Prompted");
		expect((await cli(["wait", handle], other)).stdout).toBe(`${handle} finished\n\nAnswer to From viewer\n`);
	});

	it("lets a child spawn a child, but not a third level", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Nest"]));
		const { stdout } = await cli(["wait", handle]);
		expect(stdout).toMatch(/^[a-z0-9]+ finished\n\nTool said: Spawned nested \(([a-z0-9]+)\)\nState: busy\n/);
		expect(stdout).toContain("finished\n\nTool said: Nested subagents are disabled");
		expect(called("Task:\nNest")).toBe(2);
		// The nested child belongs to its parent, not to this caller.
		expect((await cli(["list"])).stdout).not.toContain("nested");
	});

	it("stops the children that a child spawned with it", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Nest"]));
		const nested = /Spawned nested \(([a-z0-9]+)\)/.exec((await cli(["wait", handle])).stdout)?.[1] ?? "";
		expect((await cli(["status", nested])).stdout).toContain(`nested (${nested})`);
		expect((await cli(["stop", handle])).stdout).toBe(`Stopped ${handle}\n`);
		expect((await cli(["status", nested])).stderr).toBe(`Unknown subagent: ${nested}\n`);
	});

	it("lets a child spawn a child with the tool, but not a third level", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Nest tool"]));
		const { stdout } = await cli(["wait", handle]);
		expect(stdout).toMatch(
			new RegExp(
				`^${handle} finished\n\nTool said: [a-z0-9]+ finished\n\nTool said: <harness>\n\\[error\\] Nested subagents are disabled\n`,
			),
		);
		expect(called("Task:\nNest tool")).toBe(2);
	});

	it("runs a send and a wait in one message in order", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Send and wait"]));
		const { stdout } = await cli(["wait", handle]);
		expect(stdout).toMatch(
			new RegExp(`^${handle} finished\n\nTool said: [a-z0-9]+ finished\n\nAnswer to Sent message\n`),
		);
		expect(called("Sent message")).toBe(1);
	});

	it("runs the tool in a pi-durable host and reruns a wait after a restart", async () => {
		reports.length = 0;
		const context = BACKGROUND_CONTEXT;
		const store = join(root, "durable-host.sqlite");
		gates.set("Task:\nDurable child", Promise.withResolvers());
		const waiting = Promise.withResolvers<string>();
		toolWaits.set("Durable", waiting);
		let harness = await openDurable(store);

		try {
			const conversation = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root },
			});

			await conversation.submit({ type: "input", content: "Durable", requestId: "durable" }, context);
			const handle = await waiting.promise;
			await until(() => called("Task:\nDurable child") === 1);
			// Let the wait reach the host before the restart.
			await new Promise((resolve) => setTimeout(resolve, 200));
			await harness.close(context);
			harness = await openDurable(store);
			harness.resume();
			gates.get("Task:\nDurable child")?.resolve();
			const reopened = await harness.root(context);
			const submission = await reopened.submit({ type: "input", content: "Durable", requestId: "durable" }, context);
			const settled = await submission.wait(context);

			if (settled.status !== "done" || settled.answer === undefined) throw new Error(JSON.stringify(settled));
			const answer = settled.answer;
			const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
			const message = entry?.model?.[0];
			expect(message?.role === "assistant" ? message.content : []).toEqual([
				{ type: "text", text: `Tool said: ${handle} finished\n\nAnswer to Task:\nDurable child\n` },
			]);
			expect(called("Task:\nDurable child")).toBe(1);
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});

	it("reruns a pi-durable spawn after a restart and reaches the same child", async () => {
		reports.length = 0;
		const context = BACKGROUND_CONTEXT;
		const store = join(root, "durable-spawn.sqlite");
		let harness = await openDurableTool(store, true);

		try {
			const conversation = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root },
			});

			const caller = `durable-test:${conversation.id}`;
			await conversation.submit({ type: "input", content: "Durable spawn", requestId: "durable-spawn" }, context);
			await until(() => called("Task:\nDurable spawned") === 1);
			await harness.close(context);
			harness = await openDurableTool(store, false);
			harness.resume();
			const reopened = await harness.root(context);

			const submission = await reopened.submit(
				{ type: "input", content: "Durable spawn", requestId: "durable-spawn" },
				context,
			);

			const settled = await submission.wait(context);

			if (settled.status !== "done" || settled.answer === undefined) throw new Error(JSON.stringify(settled));
			const children = await request({ type: "list", caller }, { start: false });
			expect(children).toHaveLength(1);
			const answer = settled.answer;
			const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
			const message = entry?.model?.[0];
			expect(message?.role === "assistant" ? message.content : []).toEqual([
				{
					type: "text",
					text: `Tool said: ${children?.[0]?.handle} finished\n\nAnswer to Task:\nDurable spawned\n`,
				},
			]);
			expect(called("Task:\nDurable spawned")).toBe(1);
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});

	it("refuses a pi-durable spawn from a conversation without a working directory", async () => {
		reports.length = 0;
		const context = BACKGROUND_CONTEXT;
		const harness = await openDurable(join(root, "durable-no-cwd.sqlite"));

		try {
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const submission = await conversation.submit({ type: "input", content: "No cwd", requestId: "no-cwd" }, context);
			const settled = await submission.wait(context);

			if (settled.status !== "done" || settled.answer === undefined) throw new Error(JSON.stringify(settled));
			const answer = settled.answer;
			const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
			const message = entry?.model?.[0];
			const text = message?.role === "assistant" && message.content[0]?.type === "text" ? message.content[0].text : "";
			expect(text).toContain("spawn requires a caller with a working directory");
			expect(called("Task:\nNo cwd child")).toBe(0);
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});

	it("dedupes spawn and send by request ID", async () => {
		const client = await connect({ start: false });

		if (client === undefined) throw new Error("no host");

		try {
			const spawn = {
				type: "spawn",
				requestId: "spawn-once",
				caller: "cli",
				provider: "faux",
				model: "faux-1",
				callerThinking: "medium",
				cwd: root,
				prompt: "Once",
			} as const;

			const [first, second] = await Promise.all([client.request(spawn), client.request(spawn)]);
			expect(second.handle).toBe(first.handle);
			await client.request({ type: "wait", handle: first.handle, timeout: 10 });

			const send = {
				type: "send",
				requestId: "send-once",
				caller: "cli",
				handle: first.handle,
				message: "Twice?",
				followUp: false,
			} as const;

			await client.request(send);
			await client.request(send);
			expect(await client.request({ type: "wait", handle: first.handle, timeout: 10 })).toEqual({
				answer: "Answer to Twice?",
			});
			// A repeat after success finds its first submission and does not move `wait` back to it.
			await client.request(spawn);
			expect(await client.request({ type: "wait", handle: first.handle, timeout: 10 })).toEqual({
				answer: "Answer to Twice?",
			});
			await client.request({ ...send, requestId: "send-newer", message: "Newer" });
			expect(await client.request({ type: "wait", handle: first.handle, timeout: 10 })).toEqual({
				answer: "Answer to Newer",
			});
			await client.request(send);
			expect(await client.request({ type: "wait", handle: first.handle, timeout: 10 })).toEqual({
				answer: "Answer to Newer",
			});
		} finally {
			client.close();
		}

		expect(called("Once")).toBe(1);
		expect(called("Twice?")).toBe(1);
		expect(called("Newer")).toBe(1);
	});

	it("refuses a socket spawn without a working directory before it creates a child", async () => {
		const client = await connect({ start: false });

		if (client === undefined) throw new Error("no host");
		const caller = "cli-no-cwd";

		try {
			const spawn = {
				type: "spawn",
				requestId: "spawn-no-cwd",
				caller,
				provider: "faux",
				model: "faux-1",
				callerThinking: "medium",
				prompt: "Nowhere",
			};

			expect(await rawError(JSON.stringify(spawn))).toBe("spawn requires a working directory");
			expect(await client.request({ type: "list", caller })).toEqual([]);
		} finally {
			client.close();
		}
	});

	it("refuses a request line that does not match the protocol", async () => {
		expect(await rawError(JSON.stringify({ type: "nope" }))).toBe("Unknown or invalid request: nope");
		expect(await rawError(JSON.stringify({ type: "status" }))).toBe("Unknown or invalid request: status");
		expect(await rawError("[]")).toBe("Invalid request");
	});

	it("keeps the prompt of a spawn that stopped before its submit, also after a send", async () => {
		await host?.close();
		const open = Harness.open.bind(Harness);

		const opened = vi.spyOn(Harness, "open").mockImplementationOnce(async (...args) => {
			const harness = await open(...args);
			// The first conversation lookup after the spawn commits its record is the one before the submit.
			vi.spyOn(harness, "conversation").mockRejectedValueOnce(new Error("Stopped before submit"));

			return harness;
		});

		const caller = "interrupted";

		const spawn = {
			type: "spawn",
			requestId: "spawn-interrupted",
			caller,
			provider: "faux",
			model: "faux-1",
			callerThinking: "medium",
			cwd: root,
			prompt: "First prompt",
		} as const;

		try {
			host = await startHost();
			const client = await connect({ start: false });

			if (client === undefined) throw new Error("no host");

			try {
				await expect(client.request(spawn)).rejects.toThrow("Stopped before submit");
			} finally {
				client.close();
			}

			await host?.close();
		} finally {
			opened.mockRestore();
		}

		host = await startHost();
		const client = await connect({ start: false });

		if (client === undefined) throw new Error("no host");

		try {
			const [child] = await client.request({ type: "list", caller });

			if (child === undefined) throw new Error("no child");
			const handle = child.handle;
			await client.request({
				type: "send",
				requestId: "send-between",
				caller,
				handle,
				message: "Between",
				followUp: false,
			});
			expect(await client.request({ type: "wait", handle, timeout: 10 })).toEqual({ answer: "Answer to Between" });
			expect((await client.request(spawn)).handle).toBe(handle);
			expect(await client.request({ type: "wait", handle, timeout: 10 })).toEqual({
				answer: "Answer to First prompt",
			});
		} finally {
			client.close();
		}

		expect(called("First prompt")).toBe(1);
		expect(called("Between")).toBe(1);
	});

	it("finishes a turn after the host restarts", async () => {
		gates.set("Task:\nSurvive", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Survive"]));
		await until(() => called("Task:\nSurvive") === 1);
		await host?.close();
		gates.delete("Task:\nSurvive");
		host = await startHost();
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nSurvive\n`);
		expect(called("Task:\nSurvive")).toBe(2);
	});

	it("refuses a store from before the children library", async () => {
		const stateDir = await childrenStore("old-state", 1);
		await expect(runHost({ stateDir, project: "a", cwd: stateDir, models })).rejects.toThrow(
			`${join(stateDir, "durable.sqlite")} was written by an older pi-subagent`,
		);
	});

	it("does not take a store from a newer pi-subagent for an old one", async () => {
		const stateDir = await childrenStore("new-state", 3);
		const refusal = runHost({ stateDir, project: "a", cwd: stateDir, models });
		await expect(refusal).rejects.toThrow("(subagent.children) has newer version 3 than 2");
		await expect(refusal).rejects.not.toThrow("older pi-subagent");
	});

	it("runs the project agent, which keeps its history after a restart", async () => {
		const { client, lines } = await watchAgent();

		try {
			expect(lines.first.child).toMatchObject({
				handle: AGENT_HANDLE,
				name: "main agent",
				state: "idle",
				provider: "faux",
				model: "faux-1",
				thinking: "medium",
				cwd: join(root, "home"),
			});
			expect(await inputAgent(client, "Agent hello")).toBe("Prompted");
			await untilIdleAfterBusy(lines.events);
		} finally {
			client.close();
		}

		expect((await cli(["status", AGENT_HANDLE])).stderr).toBe(`Unknown subagent: ${AGENT_HANDLE}\n`);
		await host?.close();
		host = await startHost();
		const watched = await request({ type: "watch", handle: AGENT_HANDLE }, { start: false });
		expect(textsOf(watched?.view)).toEqual(["Agent hello", "Answer to Agent hello"]);
	});

	it("gives the agent of a project its directory, instructions and tools", async () => {
		const dir = realpathSync(await mkdtemp(join(root, "web-")));
		await writeFile(join(dir, "AGENTS.md"), "Web rules.");
		expect((await cli(["create", "web", "--cwd", dir])).code).toBe(0);
		const web = await startHost("web");
		process.env.HARNESS_PROJECT = "web";

		try {
			const client = await connect({ start: false });

			if (client === undefined) throw new Error("no host");

			try {
				await inputAgent(client, "Agent context");
				await until(() => requests.has("Agent context"));
			} finally {
				client.close();
			}
		} finally {
			delete process.env.HARNESS_PROJECT;
			await web?.close();
		}

		const seen = requests.get("Agent context");
		expect(seen?.system).toContain("Web rules.");
		expect(seen?.system).toContain(`<cwd>\n${dir}\n</cwd>`);
		expect(seen?.tools).toEqual(expect.arrayContaining(["read", "bash", "subagent"]));
	});

	it("sets up the agent with Pi's default model, or fails without a model", async () => {
		const settings = join(root, "agent", "settings.json");
		await writeFile(
			settings,
			JSON.stringify({
				retry: { enabled: false },
				defaultProvider: "faux",
				defaultModel: "faux-2",
				defaultThinkingLevel: "low",
			}),
		);
		process.env.XDG_STATE_HOME = join(root, "state-defaults");

		try {
			const defaults = await startHost();

			try {
				const watched = await request({ type: "watch", handle: AGENT_HANDLE }, { start: false });
				expect(watched?.child).toMatchObject({ provider: "faux", model: "faux-2", thinking: "low" });
			} finally {
				await defaults?.close();
			}

			process.env.XDG_STATE_HOME = join(root, "state-empty");

			const empty = await runHost({
				stateDir: statePaths("main").dir,
				project: "main",
				cwd: projectDir("main"),
				models: createModels(),
			});

			try {
				await expect(request({ type: "watch", handle: AGENT_HANDLE }, { start: false })).rejects.toThrow(
					"No model for the main agent",
				);
			} finally {
				await empty?.close();
			}
		} finally {
			process.env.XDG_STATE_HOME = join(root, "state");
			await writeFile(settings, JSON.stringify({ retry: { enabled: false } }));
		}
	});

	it("warns about a package whose package.json is not an object or has an invalid piDurable field, and skips it", async () => {
		const settings = join(root, "agent", "settings.json");
		const [notObject, invalidField] = [join(root, "package-array"), join(root, "package-field")];
		await mkdir(notObject);
		await mkdir(invalidField);
		await writeFile(join(notObject, "package.json"), "[]");
		await writeFile(join(invalidField, "package.json"), JSON.stringify({ piDurable: { extensions: "entry.ts" } }));
		await writeFile(settings, JSON.stringify({ retry: { enabled: false }, packages: [notObject, invalidField] }));
		process.env.XDG_STATE_HOME = join(root, "state-packages");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			const packages = await startHost();
			await packages?.close();
			expect(packages).toBeDefined();
			expect(stderr.mock.calls.map(([text]) => String(text))).toEqual(
				expect.arrayContaining([
					`warning: ${join(notObject, "package.json")} is not a valid package.json\n`,
					`warning: ${join(invalidField, "package.json")} has an invalid piDurable field\n`,
				]),
			);
		} finally {
			stderr.mockRestore();
			process.env.XDG_STATE_HOME = join(root, "state");
			await writeFile(settings, JSON.stringify({ retry: { enabled: false } }));
		}
	});

	it("makes the agent the parent of the children it spawns", async () => {
		const caller = String(ROOT_CONVERSATION_ID);
		const { client, lines } = await watchAgent();

		try {
			await inputAgent(client, "Agent spawn");
			await untilIdleAfterBusy(lines.events);
		} finally {
			client.close();
		}

		const listed = await cli(["list"], { PI_SESSION_ID: caller });
		const handle = /^nested \(([a-z0-9]+)\) {2}idle/m.exec(listed.stdout)?.[1];
		expect(handle).toBeDefined();
		await host?.close();

		const store = await Harness.open(
			await openNodeSqliteStorage(join(statePaths("main").dir, "durable.sqlite")),
			{ models, registry: durable.createRegistry() },
			BACKGROUND_CONTEXT,
		);

		try {
			const state = await store.snapshot(ChildrenDoc, BACKGROUND_CONTEXT);
			const id = String(state?.children[handle ?? ""]?.conversationId);
			expect(await createChildren(durable).lineage(store, id, BACKGROUND_CONTEXT)).toMatchObject({
				root: caller,
				parent: caller,
				depth: 1,
			});
		} finally {
			await store.close(BACKGROUND_CONTEXT);
			host = await startHost();
		}
	});

	it("aborts the agent's turn, but not the children it spawned", async () => {
		gates.set("Task:\nAgent gated", Promise.withResolvers());
		const waiting = Promise.withResolvers<string>();
		toolWaits.set("Agent waits", waiting);
		const client = await connect({ start: false });

		if (client === undefined) throw new Error("no host");

		try {
			await inputAgent(client, "Agent waits");
			const handle = await waiting.promise;
			expect((await client.request({ type: "abort", handle: AGENT_HANDLE })).state).toBe("idle");
			expect((await cli(["status", handle])).stdout).toBe(`nested (${handle}): busy (faux/faux-1, medium)\n`);
			gates.get("Task:\nAgent gated")?.resolve();
			expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nAgent gated\n`);
		} finally {
			client.close();
		}
	});

	it("prints the usage for a word that is not a project, and refuses --project with a project", async () => {
		const unknown = await cli(["lsit"]);
		expect(unknown.code).toBe(1);
		expect(unknown.stdout).toBe("");
		expect(unknown.stderr).toMatch(/^Usage:/);
		expect(await cli(["--project", "main", "main"])).toEqual({
			code: 1,
			stdout: "",
			stderr: "harness main takes no --project\n",
		});
	});

	it("starts one host for two clients", async () => {
		const state = join(root, "state2");
		process.env.XDG_STATE_HOME = state;
		let pid: number | undefined;

		try {
			const clients = await Promise.all([connect({ start: true }), connect({ start: true })]);

			for (const client of clients) client?.close();
			pid = clients[0]?.pid;
			expect(pid).toBeGreaterThan(0);
			expect(clients[1]?.pid).toBe(pid);
			expect(pid).not.toBe(process.pid);
			// The other started host finds the lock held and exits.
			const log = join(state, "harness", "main", "host.log");
			await until(() => readFileSync(log, "utf8").includes("Another harness host runs"));
		} finally {
			process.env.XDG_STATE_HOME = join(root, "state");

			if (pid !== undefined) process.kill(pid, "SIGTERM");
		}

		await until(() => !existsSync(join(state, "harness", "main", "host.sock")));
	});

	it("stops waiting for the host to start when the request aborts", async () => {
		const state = join(root, "state3");
		await mkdir(join(state, "harness", "main"), { recursive: true });
		// With the lock held, the started host exits at once, and nothing ever listens.
		const lock = new DatabaseSync(join(state, "harness", "main", "lock.sqlite"));
		lock.exec("BEGIN EXCLUSIVE");
		process.env.XDG_STATE_HOME = state;

		try {
			const signal = AbortSignal.timeout(200);
			await expect(request({ type: "list", caller: "cli" }, { start: true, signal })).rejects.toMatchObject({
				name: "TimeoutError",
			});
			// The lock stays held until the started host has found it held and exited.
			const log = join(state, "harness", "main", "host.log");
			await until(() => existsSync(log) && readFileSync(log, "utf8").includes("Another harness host runs"));
		} finally {
			process.env.XDG_STATE_HOME = join(root, "state");
			lock.close();
		}
	});
});

/** The `subagent.children` document of the host, to read a child's conversation ID. */
const ChildrenDoc = durable.defineDoc<{ children: Record<string, { conversationId: number }> }>({
	kind: "subagent.children",
	version: 2,
	scope: "session",
	initial: () => ({ children: {} }),
});

/** The text of each user and assistant message of `view`. */
function textsOf(view: Awaited<ReturnType<Client["watch"]>>["view"] | undefined): string[] {
	return (view?.entries ?? []).flatMap((entry) => {
		const message = entry.model?.[0];

		return message !== undefined && (message.role === "user" || message.role === "assistant") ? [textOf(message)] : [];
	});
}

/** A watch of the project agent of the running host, with its first reply and its events. */
async function watchAgent(): Promise<{
	client: Client;
	lines: { first: { child: ChildInfo }; events: WatchLine[] };
}> {
	const client = await connect({ start: false });

	if (client === undefined) throw new Error("no host");
	const first = await client.watch(AGENT_HANDLE);
	const events: WatchLine[] = [];
	void (async () => {
		for await (const line of first.lines) events.push(line);
	})();

	return { client, lines: { first, events } };
}

/** Sends `message` to the project agent and gives the verb. */
async function inputAgent(client: Client, message: string): Promise<string> {
	const reply = await client.request({
		type: "input",
		requestId: `input-${message}`,
		handle: AGENT_HANDLE,
		message,
		followUp: false,
	});

	return reply.verb;
}

/** Waits for an idle event after a busy one. */
async function untilIdleAfterBusy(events: readonly WatchLine[]): Promise<void> {
	const busy = () => events.findIndex((line) => !line.stopped && line.child.state === "busy");
	await until(
		() => busy() !== -1 && events.slice(busy() + 1).some((line) => !line.stopped && line.child.state === "idle"),
	);
}

/** A state directory whose store has a `subagent.children` document at `version`, as another pi-subagent writes it. */
async function childrenStore(name: string, version: number): Promise<string> {
	const stateDir = join(root, name);
	await mkdir(stateDir);

	const Children = durable.defineDoc<{ children: Record<string, string>; requests: Record<string, string> }>({
		kind: "subagent.children",
		version,
		scope: "session",
		initial: () => ({ children: {}, requests: {} }),
	});

	const store = await Harness.open(
		await openNodeSqliteStorage(join(stateDir, "durable.sqlite")),
		{ models, registry: durable.createRegistry() },
		BACKGROUND_CONTEXT,
	);

	await store.commit(async (tx) => {
		(await tx.doc(Children)).requests.other = "abcdef";
	}, BACKGROUND_CONTEXT);
	await store.close(BACKGROUND_CONTEXT);

	return stateDir;
}
