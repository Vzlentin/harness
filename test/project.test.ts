import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { type Host, runHost } from "../src/host/run.ts";
import {
	DigestReply,
	MESSAGE_STATES,
	Message,
	type MessageEvent,
	messageTransition,
	Part,
	Person,
	Rule,
	Term,
	Thread,
	ThreadMessages,
} from "../src/protocol/project.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { answerOf, cli, contexts, models, root, setUp, spawnAs, startHost, tearDown, until } from "./helpers.ts";

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

/** Runs the host of the new project `name` in this process. */
async function projectHost(name: string): Promise<Host> {
	const dir = await mkdtemp(join(root, `${name}-`));
	expect((await cli(["create", name, "--cwd", dir])).code).toBe(0);
	const started = await runHost({ project: name, cwd: dir, models });

	if (started === undefined) throw new Error("no host");

	return started;
}

/** Logs the message `text` in the thread `thread` of `project`, from `from`, at `at`, and gives it. */
async function logAt(
	project: string,
	thread: number,
	from: number | "user",
	at: number,
	text: string,
): Promise<Message> {
	const direction = from === "user" ? "out" : "in";
	const line = { type: "message", action: "log", caller: "cli", thread, from, direction, at, text } as const;

	return Value.Parse(Message, await send(line, project));
}

/** The text of the digest of `caller` in `project`, or undefined when it gets none. */
async function digestOf(project: string, caller: string): Promise<string | undefined> {
	return Value.Parse(DigestReply, await send({ type: "digest", caller }, project)).text;
}

/**
 * `<day> <month> <HH:MM>` of the time `at`, from the UTC text of `Date`, such as `12 Nov 14:22`: the format of a sent
 * time in a digest.
 */
function utcMinute(at: number): string {
	const [, day = "", month = "", , time = ""] = new Date(at).toUTCString().split(" ");

	return `${Number(day)} ${month} ${time.slice(0, 5)}`;
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

	it("moves a message out from draft to sent to answered, or to dropped, and back from sent to draft", () => {
		const events: readonly MessageEvent[] = ["sent", "draft", "dropped", "reply"];

		const moves = MESSAGE_STATES.flatMap((state) =>
			events.flatMap((event) => {
				const next = messageTransition(state, event);

				return next === undefined ? [] : [`${state} ${event} ${next}`];
			}),
		);

		expect(moves).toEqual([
			"draft sent sent",
			"draft dropped dropped",
			"draft reply sent",
			"sent draft draft",
			"sent reply answered",
		]);
	});

	it("marks a draft sent and answered by later messages of a person of its thread, and by a mark", async () => {
		const project = "outbox";
		const outbox = await projectHost(project);

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));
			const rufin = Value.Parse(Person, await send({ type: "person", action: "add", name: "Rufin" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
			);

			const states = async () => {
				const read = Value.Parse(
					ThreadMessages,
					await send({ type: "thread", action: "read", id: thread.id }, project),
				);

				return read.messages.map((message) => `${message.text}: ${message.state}`);
			};

			await logAt(project, thread.id, "user", 2_000, "Types 45 and 54.");
			// A pasted message that is older than the draft, and a message of a person out of the thread, do not move it.
			await logAt(project, thread.id, sam.id, 1_000, "Which types?");
			await logAt(project, thread.id, rufin.id, 3_000, "Not my thread.");
			expect(await states()).toEqual(["Types 45 and 54.: draft", "Which types?: received", "Not my thread.: received"]);

			// Each later message of a person of the thread moves the draft one step.
			await logAt(project, thread.id, sam.id, 3_000, "Got it.");
			expect((await states())[0]).toBe("Types 45 and 54.: sent");
			await logAt(project, thread.id, sam.id, 4_000, "Agreed.");
			expect((await states())[0]).toBe("Types 45 and 54.: answered");

			const draft = await logAt(project, thread.id, "user", 5_000, "And type 56?");
			const mark = { type: "message", action: "mark", caller: "cli", message: draft.id } as const;
			expect(await send({ ...mark, state: "sent" }, project)).toEqual({ ...draft, state: "sent" });
			expect(await send({ ...mark, state: "draft" }, project)).toEqual(draft);
			expect(await send({ ...mark, state: "dropped" }, project)).toEqual({ ...draft, state: "dropped" });
			await expect(send({ ...mark, state: "sent" }, project)).rejects.toThrow(
				`Message ${draft.id} is dropped: it cannot become sent`,
			);
			// A later message does not move a dropped message.
			await logAt(project, thread.id, sam.id, 6_000, "Yes.");
			expect((await states())[5]).toBe("And type 56?: dropped");

			const asked = await logAt(project, thread.id, sam.id, 7_000, "Done?");
			await expect(send({ ...mark, message: asked.id, state: "sent" }, project)).rejects.toThrow(
				`Message ${asked.id} is a message in: only a message out has a mark`,
			);
			await expect(send({ ...mark, message: 999_999, state: "sent" }, project)).rejects.toThrow(
				"Unknown message: 999999",
			);
			await expect(send(JSON.parse(JSON.stringify({ ...mark, state: "answered" })), project)).rejects.toThrow(
				"Invalid message request: state is not valid",
			);
		} finally {
			await outbox.close();
		}
	});

	it("gives a caller its digest of the messages that wait only when it changed", async () => {
		const project = "digest";
		const digests = await projectHost(project);

		try {
			// A caller that never got a digest gets none while nothing waits.
			expect(await digestOf(project, "pi-1")).toBeUndefined();
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));
			const benoit = Value.Parse(Person, await send({ type: "person", action: "add", name: "Benoit" }, project));

			const brand = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "own-brand C+P", persons: [sam.id] }, project),
			);

			const loyalty = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "double loyalty", persons: [benoit.id] }, project),
			);

			const toSam = await logAt(project, brand.id, "user", 1_000, "The scope.");
			const toBenoit = await logAt(project, loyalty.id, "user", 1_000, "The rule.");
			const mark = { type: "message", action: "mark", caller: "cli" } as const;
			const before = Date.now();
			await send({ ...mark, message: toSam.id, state: "sent" }, project);
			const after = Date.now();
			// The time of the mark is between `before` and `after`, which can be in two minutes.
			const sent = (at: number) => `Sam (own-brand C+P, sent ${utcMinute(at)})`;
			const both = (at: number) => `waiting on: ${sent(at)} · Benoit (double loyalty, draft not sent)\nheld: none`;
			expect([before, after].map(both)).toContain(await digestOf(project, "pi-1"));
			expect(await digestOf(project, "pi-1")).toBeUndefined();

			await send({ ...mark, message: toBenoit.id, state: "dropped" }, project);
			const samOnly = (at: number) => `waiting on: ${sent(at)}\nheld: none`;
			expect([before, after].map(samOnly)).toContain(await digestOf(project, "pi-1"));
			// Each caller has its own last digest.
			expect([before, after].map(samOnly)).toContain(await digestOf(project, "pi-2"));

			await logAt(project, brand.id, sam.id, 2_000, "Thanks.");
			expect(await digestOf(project, "pi-1")).toBe("waiting on: none\nheld: none");
			expect(await digestOf(project, "pi-1")).toBeUndefined();
			expect(await digestOf(project, "pi-3")).toBeUndefined();
		} finally {
			await digests.close();
		}
	});

	it("writes the digest into the conversation of a child before its spawn and its send, only when it changed", async () => {
		const project = "digest-child";
		const digests = await projectHost(project);

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
			);

			const draft = await logAt(project, thread.id, "user", 1_000, "The scope.");
			const waiting = "waiting on: Sam (Scope, draft not sent)\nheld: none";
			const child = await spawnAs("digest-test", "Digest one", { notify: false, project });
			await answerOf(child.handle, project);
			expect(contexts.get("Digest one")).toEqual([waiting, "Digest one"]);

			const line = {
				type: "send",
				caller: "digest-test",
				handle: child.handle,
				followUp: false,
				notify: false,
			} as const;

			await send({ ...line, requestId: "two", message: "Digest two" }, project);
			await answerOf(child.handle, project);
			expect(contexts.get("Digest two")).toEqual([waiting, "Digest one", "Digest two"]);

			const mark = { type: "message", action: "mark", caller: "cli", message: draft.id, state: "dropped" } as const;
			await send(mark, project);
			await send({ ...line, requestId: "three", message: "Digest three" }, project);
			await answerOf(child.handle, project);
			expect(contexts.get("Digest three")).toEqual([
				waiting,
				"Digest one",
				"Digest two",
				"waiting on: none\nheld: none",
				"Digest three",
			]);
		} finally {
			await digests.close();
		}
	});
});
