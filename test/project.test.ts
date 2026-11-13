import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { Message, Part, Person, Rule, Term, Thread } from "../src/protocol/project.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { cli, models, root, setUp, startHost, tearDown, until } from "./helpers.ts";

const RuleList = Type.Object({ rules: Type.Array(Rule) });

let host: Host | undefined;

/** Sends `line` to the host of `project` through the socket. */
async function send<T extends Request["type"]>(
	line: Extract<Request, { type: T }>,
	project?: string,
): Promise<Replies[T]> {
	const reply = await request(line, { start: false, project });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the store of the project", { timeout: 30_000 }, () => {
	it("keeps persons, threads, messages, rules, terms and parts, also after a host restart", async () => {
		const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }));
		const rufin = Value.Parse(Person, await send({ type: "person", action: "add", name: "Rufin" }));
		expect([sam.id, rufin.id]).toEqual([1, 2]);

		const thread = Value.Parse(
			Thread,
			await send({
				type: "thread",
				action: "add",
				topic: "Agent Mandat",
				persons: [sam.id, rufin.id],
			}),
		);

		expect(thread).toMatchObject({ topic: "Agent Mandat", persons: [1, 2] });

		const asked = Value.Parse(
			Message,
			await send({
				type: "message",
				action: "log",
				caller: "cli",
				thread: thread.id,
				from: sam.id,
				direction: "in",
				at: 1_000,
				text: "Which sale types are in scope?",
			}),
		);

		expect(asked).toMatchObject({
			thread: thread.id,
			from: 1,
			direction: "in",
			state: "received",
			at: 1_000,
			by: "cli",
		});
		const before = Date.now();

		const answer = await send({
			type: "message",
			action: "log",
			caller: "cli",
			thread: thread.id,
			from: "user",
			direction: "out",
			text: "45, 54 and 56 only.",
		});

		expect(answer).toMatchObject({ from: "user", direction: "out", state: "draft" });
		expect(answer.at).toBeGreaterThanOrEqual(before);

		const scope = Value.Parse(
			Rule,
			await send({
				type: "rule",
				action: "set",
				caller: "cli",
				name: "scope",
				kind: "domain",
				value: "Sale types in scope are 45, 54 and 56.",
				saidBy: "user",
				source: answer.id,
			}),
		);

		expect(scope).toMatchObject({ id: 1, name: "scope", status: "open", saidBy: "user", source: answer.id });

		const ask = Value.Parse(
			Rule,
			await send({
				type: "rule",
				action: "set",
				caller: "cli",
				name: "ask first",
				kind: "conduct",
				value: "Ask before a write that Sam sees.",
				status: "decided",
				saidBy: sam.id,
				source: asked.id,
			}),
		);

		const term = Value.Parse(
			Term,
			await send({
				type: "term",
				action: "set",
				caller: "cli",
				name: "mandat",
				meaning: "A signed order of sale.",
				avoid: ["contract"],
				saidBy: "user",
				source: answer.id,
			}),
		);

		expect(term).toMatchObject({ id: 1, avoid: ["contract"] });

		const diagram = Value.Parse(
			Part,
			await send({
				type: "part",
				action: "add",
				caller: "cli",
				kind: "diagram",
				path: "parts/scope.md",
				rules: [scope.id],
				terms: [],
			}),
		);

		const table = Value.Parse(
			Part,
			await send({
				type: "part",
				action: "add",
				caller: "cli",
				kind: "table",
				path: "parts/terms.md",
				rules: [ask.id],
				terms: [term.id],
			}),
		);

		expect(diagram).toMatchObject({ id: 1, stale: false });
		expect(diagram.checked).toBeGreaterThanOrEqual(before);

		// A new rule that replaces the scope retires it, and makes stale only the part that explains it.
		const wider = Value.Parse(
			Rule,
			await send({
				type: "rule",
				action: "set",
				caller: "cli",
				name: "scope",
				kind: "domain",
				value: "Sale types in scope are 45, 54, 56 and 61.",
				saidBy: sam.id,
				source: asked.id,
				replaces: scope.id,
			}),
		);

		expect(wider).toMatchObject({ id: 3, replaces: scope.id, status: "open", saidBy: sam.id, source: asked.id });
		// The retired rule keeps the person who said it and its source message.
		expect(await send({ type: "rule", action: "list", status: "retired" })).toMatchObject({
			rules: [{ id: scope.id, status: "retired", saidBy: "user", source: answer.id }],
		});
		expect(await send({ type: "part", action: "list" })).toMatchObject({
			parts: [
				{ id: diagram.id, stale: true },
				{ id: table.id, stale: false },
			],
		});

		// A change of a term makes its part stale, and a check clears it.
		await send({
			type: "term",
			action: "set",
			caller: "cli",
			id: term.id,
			meaning: "A signed mandate.",
			saidBy: sam.id,
			source: asked.id,
		});
		expect(await send({ type: "part", action: "list", term: term.id })).toMatchObject({
			parts: [{ id: table.id, stale: true }],
		});
		expect(await send({ type: "part", action: "check", caller: "cli", id: table.id })).toMatchObject({
			id: table.id,
			stale: false,
		});
		expect(await send({ type: "part", action: "list", rule: scope.id })).toMatchObject({ parts: [{ id: diagram.id }] });

		const stored = {
			persons: await send({ type: "person", action: "list" }),
			threads: await send({ type: "thread", action: "list" }),
			read: await send({ type: "thread", action: "read", id: thread.id }),
			rules: await send({ type: "rule", action: "list" }),
			terms: await send({ type: "term", action: "list" }),
			parts: await send({ type: "part", action: "list" }),
		};

		expect(stored.read).toEqual({ thread: { ...thread, last: answer.at }, messages: [asked, answer] });
		expect(stored.rules).toMatchObject({
			rules: [
				{ id: scope.id, status: "retired" },
				{ id: ask.id, status: "decided", saidBy: sam.id },
				{ id: wider.id, status: "open" },
			],
		});
		expect(stored.terms).toMatchObject({ terms: [{ meaning: "A signed mandate.", saidBy: sam.id }] });

		await host?.close();
		host = await startHost();

		expect({
			persons: await send({ type: "person", action: "list" }),
			threads: await send({ type: "thread", action: "list" }),
			read: await send({ type: "thread", action: "read", id: thread.id }),
			rules: await send({ type: "rule", action: "list" }),
			terms: await send({ type: "term", action: "list" }),
			parts: await send({ type: "part", action: "list" }),
		}).toEqual(stored);
	});

	it("refuses a bad request with a clear error, and changes nothing", async () => {
		const person = Value.Parse(Person, await send({ type: "person", action: "add", name: "Ana" }));

		const thread = Value.Parse(
			Thread,
			await send({ type: "thread", action: "add", topic: "Errors", persons: [person.id] }),
		);

		const message = await send({
			type: "message",
			action: "log",
			caller: "cli",
			thread: thread.id,
			from: person.id,
			direction: "in",
			text: "Use the SQL of the product.",
		});

		const rule = Value.Parse(
			Rule,
			await send({
				type: "rule",
				action: "set",
				caller: "cli",
				name: "SQL",
				kind: "conduct",
				value: "Numbers come from the product's SQL.",
				saidBy: person.id,
				source: message.id,
			}),
		);

		const read = async () => ({
			persons: await send({ type: "person", action: "list" }),
			threads: await send({ type: "thread", action: "list" }),
			thread: await send({ type: "thread", action: "read", id: thread.id }),
			rules: await send({ type: "rule", action: "list" }),
			terms: await send({ type: "term", action: "list" }),
			parts: await send({ type: "part", action: "list" }),
		});

		const before = await read();

		const rule2 = {
			type: "rule",
			action: "set",
			caller: "cli",
			name: "fact",
			kind: "domain",
			value: "A fact.",
			saidBy: "user",
		} as const;

		const newRule = { ...rule2, source: message.id };
		const { source: _source, ...noSource } = newRule;
		const { saidBy: _saidBy, ...noAuthor } = newRule;
		const { name: _name, ...noName } = newRule;

		const badLines: readonly (readonly [Record<string, JsonValue>, string])[] = [
			[noSource, "Invalid rule request: source is required"],
			[noAuthor, "Invalid rule request: saidBy is required"],
			[noName, "Invalid rule request: name is required"],
			[{ ...newRule, name: " " }, "Invalid rule request: name is not valid"],
			[
				{ type: "rule", action: "set", caller: "cli", id: rule.id, status: "retired", saidBy: "user" },
				"Invalid rule request: source is required",
			],
			[
				{ type: "term", action: "set", caller: "cli", name: "x", meaning: "y", saidBy: "user" },
				"Invalid term request: source is required",
			],
			[{ ...newRule, status: "final" }, "Invalid rule request: status is not valid"],
			[{ type: "thread", action: "add", topic: "No one", persons: [] }, "Invalid thread request: persons is not valid"],
			[{ type: "person", action: "add", name: " " }, "Invalid person request: name is not valid"],
		];

		// The request types refuse these lines, so they go through JSON.
		for (const [line, error] of badLines) await expect(send(JSON.parse(JSON.stringify(line)))).rejects.toThrow(error);

		await expect(send({ ...newRule, id: rule.id, replaces: rule.id })).rejects.toThrow(
			"A change of a rule cannot replace a rule: set replaces on a new rule",
		);

		await expect(send({ type: "thread", action: "add", topic: "Ghost", persons: [person.id, 99] })).rejects.toThrow(
			"Unknown person: 99",
		);

		const log = {
			type: "message",
			action: "log",
			caller: "cli",
			thread: thread.id,
			from: person.id,
			direction: "in",
			text: "Hi",
		} as const;

		await expect(send({ ...log, thread: 999_999 })).rejects.toThrow("Unknown thread: 999999");
		await expect(send({ ...log, from: 99 })).rejects.toThrow("Unknown person: 99");
		await expect(send({ type: "thread", action: "read", id: 999_999 })).rejects.toThrow("Unknown thread: 999999");
		await expect(send({ ...rule2, source: 999_999 })).rejects.toThrow("Unknown message: 999999");
		// A conversation ID is not a message.
		await expect(send({ ...rule2, source: thread.id })).rejects.toThrow(`Unknown message: ${thread.id}`);
		await expect(send({ ...rule2, saidBy: 99, source: message.id })).rejects.toThrow("Unknown person: 99");
		await expect(send({ ...rule2, source: message.id, replaces: 99 })).rejects.toThrow("Unknown rule: 99");
		await expect(
			send({
				type: "rule",
				action: "set",
				caller: "cli",
				id: 99,
				status: "retired",
				saidBy: "user",
				source: message.id,
			}),
		).rejects.toThrow("Unknown rule: 99");
		await expect(
			send({ type: "term", action: "set", caller: "cli", id: 99, meaning: "z", saidBy: "user", source: message.id }),
		).rejects.toThrow("Unknown term: 99");

		const part = {
			type: "part",
			action: "add",
			caller: "cli",
			kind: "example",
			path: "parts/x.md",
			rules: [],
			terms: [],
		} as const;

		const none: number[] = [];
		await expect(send({ ...part, rules: [rule.id, 99], terms: none })).rejects.toThrow("Unknown rule: 99");
		await expect(send({ ...part, rules: none, terms: [99] })).rejects.toThrow("Unknown term: 99");
		await expect(send({ type: "part", action: "check", caller: "cli", id: 99 })).rejects.toThrow("Unknown part: 99");

		expect(await read()).toEqual(before);
	});

	it("reads the rules of a kind and of a status, and changes the name of a rule", async () => {
		const dir = await mkdtemp(join(root, "rules-"));
		expect((await cli(["create", "rules", "--cwd", dir])).code).toBe(0);
		const rules = await runHost({ project: "rules", cwd: dir, models });

		if (rules === undefined) throw new Error("no host");

		try {
			const person = Value.Parse(Person, await send({ type: "person", action: "add", name: "Lea" }, "rules"));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Filters", persons: [person.id] }, "rules"),
			);

			const source = (
				await send(
					{
						type: "message",
						action: "log",
						caller: "cli",
						thread: thread.id,
						from: "user",
						direction: "out",
						text: "Rules.",
					},
					"rules",
				)
			).id;

			const said = { type: "rule", action: "set", caller: "cli", saidBy: "user", source } as const;

			const add = async (name: string, kind: "conduct" | "domain", status: "open" | "decided" | "retired") =>
				Value.Parse(Rule, await send({ ...said, name, kind, value: `The rule ${name}.`, status }, "rules")).id;

			const openConduct = await add("a", "conduct", "open");
			const decidedConduct = await add("b", "conduct", "decided");
			const openDomain = await add("c", "domain", "open");
			const decidedDomain = await add("d", "domain", "decided");
			const retiredDomain = await add("e", "domain", "retired");

			const ids = async (filter: { kind?: "conduct" | "domain"; status?: "open" | "decided" | "retired" }) =>
				Value.Parse(RuleList, await send({ type: "rule", action: "list", ...filter }, "rules")).rules.map(
					(rule) => rule.id,
				);

			expect(await ids({})).toEqual([openConduct, decidedConduct, openDomain, decidedDomain, retiredDomain]);
			expect(await ids({ kind: "conduct" })).toEqual([openConduct, decidedConduct]);
			expect(await ids({ status: "decided" })).toEqual([decidedConduct, decidedDomain]);
			expect(await ids({ kind: "domain", status: "open" })).toEqual([openDomain]);
			expect(await ids({ kind: "conduct", status: "retired" })).toEqual([]);

			expect(await send({ ...said, id: openDomain, name: "c2" }, "rules")).toMatchObject({
				id: openDomain,
				name: "c2",
				value: "The rule c.",
			});
		} finally {
			await rules.close();
		}
	});

	it("counts a change of the store as activity for the idle exit, and a list or a read not", async () => {
		const dir = await mkdtemp(join(root, "idle-"));
		expect((await cli(["create", "idle-store", "--cwd", dir])).code).toBe(0);
		const idle = await runHost({ project: "idle-store", cwd: dir, models, idleExitMs: 300 });

		if (idle === undefined) throw new Error("no host");
		let closed = false;
		void idle.closed.then(() => (closed = true));

		try {
			for (const end = Date.now() + 1000; Date.now() < end;) {
				await send({ type: "person", action: "add", name: "Keep the host up" }, "idle-store");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			expect(closed).toBe(false);

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Poll", persons: [1] }, "idle-store"),
			);

			const polling = (async () => {
				while (!closed) {
					await send({ type: "rule", action: "list" }, "idle-store").catch(() => undefined);
					await send({ type: "thread", action: "read", id: thread.id }, "idle-store").catch(() => undefined);
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			})();

			await until(() => closed);
			await polling;
		} finally {
			await idle.close();
		}
	});
});
