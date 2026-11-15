import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { projectToolsExtension } from "../src/project-tool.ts";
import { AskWrite, Message, Person, RuleList, Thread } from "../src/protocol/project.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import {
	agentTurn,
	answerContent,
	cellResults,
	cli,
	handleOf,
	openDurableHost,
	reports,
	requests,
	root,
	scripts,
	setSettings,
	setUp,
	startHost,
	tearDown,
} from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

let host: Host | undefined;

/** Sends `line` to the host through the socket. */
async function send<T extends Request["type"]>(line: Extract<Request, { type: T }>): Promise<Replies[T]> {
	const reply = await request(line, { start: false });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/**
 * A pi-durable host over `store` with the tools of the store of the project, where the caller is
 * `durable-project:<conversation ID>`. With `reached`, a request that is not about a person reaches the harness host, then
 * calls `reached`, and the call never finishes.
 */
function openProjectHost(store: string, reached?: () => void): Promise<Harness> {
	const extension = projectToolsExtension(
		durable,
		{ Type },
		{
			caller: async (api) => `durable-project:${api.conversationId}`,
			send: async (message, signal) => {
				const reply = await request(message, { start: false, signal });

				if (reply === undefined) throw new Error("no host");

				if (reached === undefined || message.type === "person") return reply;
				reached();

				return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
			},
		},
	);

	return openDurableHost(store, [extension]);
}

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the tools of the store of the project", { timeout: 30_000 }, () => {
	it("log and read messages, and set and list rules, for a child", async () => {
		const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }));

		const thread = Value.Parse(
			Thread,
			await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }),
		);

		const prompt = "Task:\nKeep the project";
		const at = Date.UTC(2026, 10, 12, 13, 26);

		scripts.set(prompt, [
			{ name: "thread", arguments: { action: "log", thread: thread.id, from: sam.id, at, text: "Which types?" } },
			{ name: "thread", arguments: { action: "draft", thread: thread.id, text: "45 and 54." } },
			{ name: "thread", arguments: { action: "log", thread: thread.id, from: sam.id, at: at - 60_000, text: "Hi" } },
			{ name: "thread", arguments: { action: "list" } },
			{ name: "thread", arguments: { action: "read", thread: thread.id } },
			{
				name: "rule",
				arguments: { action: "set", name: "scope", kind: "domain", value: "45 and 54.", saidBy: "user" },
			},
		]);

		const handle = handleOf(await cli(["spawn", "--prompt", "Keep the project"]));
		await cli(["wait", handle]);
		const results = cellResults.get(prompt) ?? [];
		const read = await send({ type: "thread", action: "read", id: thread.id });

		if (!("messages" in read)) throw new Error("no messages");
		const [asked, draft, hi] = read.messages.map((message) => Value.Parse(Message, message));

		if (asked === undefined || hi === undefined || draft === undefined) throw new Error("missing messages");
		expect(asked).toMatchObject({ from: sam.id, direction: "in", state: "received", at, text: "Which types?" });
		expect(draft).toMatchObject({ from: "user", direction: "out", state: "draft", text: "45 and 54." });
		// The host keeps the conversation of the child as the caller that logged each message.
		expect(asked.by).toMatch(/^\d+$/);
		expect([draft.by, hi.by]).toEqual([asked.by, asked.by]);
		// The older message does not move the time of the last message back.
		expect(read.thread.last).toBe(draft.at);
		const threadText = `${thread.id} Scope with Sam (${sam.id}): last message ${new Date(draft.at).toISOString()}\n`;

		const messages = [
			`${asked.id} 2026-11-12T13:26:00.000Z Sam (${sam.id}) (received): Which types?\n`,
			`${draft.id} ${new Date(draft.at).toISOString()} user (draft): 45 and 54.\n`,
			`${hi.id} 2026-11-12T13:25:00.000Z Sam (${sam.id}) (received): Hi\n`,
		];

		// The list of the threads gives one line for the thread and no message text; the read gives the messages.
		expect(results.slice(0, 5)).toEqual([...messages, threadText, threadText + messages.join("")]);
		// The runner refuses a rule without its source before it sends it.
		expect(results[5]).toContain("set requires source");
		expect(await send({ type: "rule", action: "list" })).toEqual({ rules: [] });

		const facts = "Task:\nKeep the facts";

		scripts.set(facts, [
			{
				name: "rule",
				arguments: {
					action: "set",
					name: "scope",
					kind: "domain",
					value: "45 and 54.",
					saidBy: "user",
					source: draft.id,
				},
			},
			{ name: "rule", arguments: { action: "set", id: 1, status: "decided", saidBy: "user", source: draft.id } },
			{ name: "rule", arguments: { action: "list", kind: "domain" } },
		]);

		const second = handleOf(await cli(["spawn", "--prompt", "Keep the facts"]));
		await cli(["wait", second]);
		const line = `1 scope (domain, open): 45 and 54. [said by user in message ${draft.id}]\n`;
		// A child cannot decide a rule: the tool has no status, so its validator drops it, and the rule stays open.
		expect(cellResults.get(facts)).toEqual([line, line, line]);
		const rules = await send({ type: "rule", action: "list" });
		expect(rules).toMatchObject({ rules: [{ id: 1, status: "open", saidBy: "user", source: draft.id }] });
		// The second child wrote the facts, so its conversation is their caller, not the one that logged the messages.
		const factsBy = Value.Parse(RuleList, rules).rules[0]?.by;
		expect(factsBy).toMatch(/^\d+$/);
		expect(factsBy).not.toBe(asked.by);
	});

	it("writes and reads the asks of a parley and the asks with no parley, with their text form", async () => {
		const prompt = "Task:\nKeep the parley";

		const options = [
			{ key: "a", label: "In the store", gains: ["One writer"] },
			{ key: "b", label: "In files" },
		];

		scripts.set(prompt, [
			{
				name: "parley",
				arguments: {
					action: "round",
					slug: "where",
					title: "Where asks live",
					goal: "Pick the place.",
					design_sense: "One writer.",
					asks: [
						{ title: "Where", kind: "your call", options, plan: "a", view: "A `table` of the places" },
						{ title: "These are the terms" },
					],
				},
			},
			{ name: "parley", arguments: { action: "read", slug: "where", ask: 1 } },
			{ name: "parley", arguments: { action: "answer", slug: "where", answers: [{ ask: 1, answer: "z" }] } },
			{
				name: "parley",
				arguments: {
					action: "answer",
					slug: "where",
					answers: [
						{ ask: 1, answer: "b" },
						{ ask: 2, answer: "ok" },
					],
				},
			},
			{ name: "parley", arguments: { action: "round", goal: "No parley", asks: [{ title: "Push now?" }] } },
			{ name: "parley", arguments: { action: "round", asks: [{ title: "Push now?" }] } },
			{ name: "parley", arguments: { action: "read", ask: 3 } },
			{ name: "parley", arguments: { action: "read", slug: "where", ask: 9 } },
			{ name: "parley", arguments: { action: "list" } },
			{ name: "parley", arguments: { action: "drop", slug: "nope" } },
		]);

		const handle = handleOf(await cli(["spawn", "--prompt", "Keep the parley"]));
		await cli(["wait", handle]);
		const results = cellResults.get(prompt) ?? [];

		expect(results.slice(0, 2)).toEqual([
			"where · open · Where asks live\n1 · Where · your call · open · plan a · In the store\n2 · These are the terms · open\n[where] 1a ok\n",
			"1 · Where · your call · open · plan a · In the store\nA `table` of the places\n",
		]);
		// The host refuses the answer, and its error reaches the call.
		expect(results[2]).toContain("Ask 1 takes a, b or own");

		expect(results[3]).toBe(
			"where · contract · Where asks live\n1 · Where · your call · b · In files\n2 · These are the terms · ok\nharness parley show where\n",
		);
		expect(results[4]).toContain("round requires slug");
		expect(results.slice(5, 7)).toEqual(["3 · Push now? · open\n", "3 · Push now? · open\n"]);
		expect(results[7]).toContain("Parley where has no ask 9");
		expect(results[8]).toBe("where · contract · Where asks live\n3 · Push now? · open\n");
		// The runner refuses the drop before it reads the unknown parley.
		expect(results[9]).toContain("drop requires ask");
	});

	it("runs the flow of the parley skill from its first round to the contract", async () => {
		const prompt = "Task:\nRun the parley flow";

		const calls = [
			{ title: "Where", kind: "your call", options: [{ key: "a", label: "In the store" }], plan: "a" },
			{
				title: "How",
				kind: "my call",
				options: [
					{ key: "a", label: "Slow" },
					{ key: "b", label: "Fast", gains: ["Half the time"] },
				],
				plan: "b",
			},
		];

		scripts.set(prompt, [
			// Step 2: the calls, in a round.
			{ name: "parley", arguments: { action: "round", slug: "flow", title: "Flow", goal: "Pick.", asks: calls } },
			// Step 3: the state in the chat.
			{ name: "parley", arguments: { action: "read", slug: "flow" } },
			// Step 4: the line `[flow] 1a ok`, where ok takes the plan of the my call 2.
			{
				name: "parley",
				arguments: {
					action: "answer",
					slug: "flow",
					answers: [
						{ ask: 1, answer: "a" },
						{ ask: 2, answer: "b" },
					],
				},
			},
			// Step 5: the read-back and the design sense, in one round.
			{
				name: "parley",
				arguments: {
					action: "round",
					slug: "flow",
					design_sense: "Reuse the store.",
					asks: [{ title: "These are the terms" }],
				},
			},
			// Step 6: the line `[flow] ok`.
			{ name: "parley", arguments: { action: "answer", slug: "flow", answers: [{ ask: 3, answer: "ok" }] } },
		]);

		const handle = handleOf(await cli(["spawn", "--prompt", "Run the parley flow"]));
		await cli(["wait", handle]);
		const head = "flow · open · Flow\n1 · Where · your call · ";
		const open = `${head}open · plan a · In the store\n2 · How · my call · open · plan b · Fast\n[flow] 1a ok\n`;
		const answered = `${head}a · In the store\n2 · How · my call · b · Fast\n`;

		expect(cellResults.get(prompt)).toEqual([
			open,
			open,
			`${answered}[flow] ok\n`,
			`${answered}3 · These are the terms · open\n[flow] ok\n`,
			`${answered.replace("flow · open", "flow · contract")}3 · These are the terms · ok\nharness parley show flow\n`,
		]);
	});

	it("reads an ask with no parley after its answer, with its view", async () => {
		const ask = { title: "Tag it?", view: "The tag `v1`" };
		const asked = Value.Parse(AskWrite, await send({ type: "ask", action: "round", caller: "khan", asks: [ask] }));
		const id = asked.asks[0]?.id ?? 0;
		await send({ type: "ask", action: "answer", caller: "user", answers: [{ id, answer: "own", label: "Yes" }] });
		const prompt = "Task:\nRead the answered ask";
		scripts.set(prompt, [{ name: "parley", arguments: { action: "read", ask: id } }]);
		const handle = handleOf(await cli(["spawn", "--prompt", "Read the answered ask"]));
		await cli(["wait", handle]);

		expect(cellResults.get(prompt)).toEqual([`${id} · Tag it? · own · Yes\nThe tag \`v1\`\n`]);
	});

	it("gives the tools to the project agent and to a child at the depth limit", async () => {
		await agentTurn("Agent project tools");
		expect(requests.get("Agent project tools")?.tools).toEqual(expect.arrayContaining(["thread", "rule", "parley"]));
		expect(requests.get("Agent project tools")?.tools).not.toEqual(expect.arrayContaining(["term"]));
		expect(requests.get("Agent project tools")?.tools).not.toEqual(expect.arrayContaining(["part"]));
		await setSettings({ agentDepthLimit: 1 });

		try {
			scripts.set("Task:\nLeaf threads", [{ name: "thread", arguments: { action: "list" } }]);
			const handle = handleOf(await cli(["spawn", "--prompt", "Leaf threads"]));

			expect((await cli(["wait", handle])).stdout).toMatch(/Scope with Sam \(\d+\)/);
			expect(requests.get("Task:\nLeaf threads")?.tools).toEqual(expect.arrayContaining(["thread", "rule", "parley"]));
			expect(requests.get("Task:\nLeaf threads")?.tools).not.toEqual(expect.arrayContaining(["term"]));
			expect(requests.get("Task:\nLeaf threads")?.tools).not.toEqual(expect.arrayContaining(["part"]));
		} finally {
			await setSettings();
		}
	});

	it("does not run again a call that a restart interrupts, so a message is logged once", async () => {
		reports.length = 0;
		const ana = Value.Parse(Person, await send({ type: "person", action: "add", name: "Ana" }));
		const thread = Value.Parse(Thread, await send({ type: "thread", action: "add", topic: "Once", persons: [ana.id] }));
		const prompt = "Durable thread";

		scripts.set(prompt, [
			{ name: "thread", arguments: { action: "log", thread: thread.id, from: ana.id, text: "Only once" } },
			{ name: "thread", arguments: { action: "list" } },
		]);

		const store = join(root, "durable-project.sqlite");
		const reached = Promise.withResolvers<void>();
		let harness = await openProjectHost(store, reached.resolve);

		try {
			const conversation = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root },
			});

			const caller = `durable-project:${conversation.id}`;

			const input = { type: "input", content: prompt, requestId: "durable-thread" } as const;
			await conversation.submit(input, context);
			await reached.promise;
			await harness.close(context);
			harness = await openProjectHost(store);
			harness.resume();
			const settled = await (await (await harness.root(context)).submit(input, context)).wait(context);

			expect(await answerContent(harness, settled)).toEqual([
				{ type: "text", text: expect.stringContaining(`Once with Ana (${ana.id}): last message`) },
			]);
			expect(cellResults.get(prompt)?.[0]).toContain("Tool thread was interrupted and may have partially run");
			expect(await send({ type: "thread", action: "read", id: thread.id })).toMatchObject({
				messages: [{ text: "Only once", by: caller }],
			});
			expect(reports).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});
});
