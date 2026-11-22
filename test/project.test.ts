import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { WorkItem } from "../src/protocol/item.ts";
import { statePaths } from "../src/protocol/paths.ts";
import {
	DigestReply,
	MESSAGE_STATES,
	Message,
	type MessageEvent,
	messageTransition,
	Person,
	Rule,
	rulesSection,
	Thread,
	ThreadMessages,
} from "../src/protocol/project.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import {
	answerOf,
	cli,
	contexts,
	models,
	requests,
	root,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

/** The first line of the section of the decided rules. */
const RULES_HEAD =
	"A rule is what a person of the project said that each agent follows (conduct) or knows as true (domain); only the user puts a rule in effect. Propose a rule with the `rule` tool, and never write a rule into `AGENTS.md`.";

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

/** The rows of `sql` in `project.sqlite` of `project`, read with a read-only connection, as plain objects. */
function storeRows(project: string, sql: string): Record<string, SQLOutputValue>[] {
	const db = new DatabaseSync(join(statePaths(project).dir, "project.sqlite"), { readOnly: true });

	try {
		return db
			.prepare(sql)
			.all()
			.map((row) => ({ ...row }));
	} finally {
		db.close();
	}
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
	it("keeps persons, threads, messages and rules, also after a host restart", async () => {
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

		// A rule gives the thread of its source message.
		expect(scope).toMatchObject({
			id: 1,
			name: "scope",
			status: "open",
			saidBy: "user",
			source: answer.id,
			thread: thread.id,
		});

		const ask = Value.Parse(
			Rule,
			await send({
				type: "rule",
				action: "set",
				caller: "cli",
				name: "ask first",
				kind: "conduct",
				value: "Ask before a write that Sam sees.",
				saidBy: sam.id,
				source: asked.id,
			}),
		);

		expect(await send({ type: "rule", action: "decide", caller: "user", id: ask.id })).toMatchObject({
			id: ask.id,
			status: "decided",
			saidBy: sam.id,
			source: asked.id,
			by: "user",
		});

		// A new rule names the rule that it replaces, which stays open until the user decides the new rule.
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
		expect(await send({ type: "rule", action: "list", status: "retired" })).toEqual({ rules: [] });
		expect(await send({ type: "rule", action: "decide", caller: "user", id: wider.id })).toMatchObject({
			id: wider.id,
			status: "decided",
		});
		// The retired rule keeps the person who said it, its source message and the thread of that message.
		expect(await send({ type: "rule", action: "list", status: "retired" })).toMatchObject({
			rules: [{ id: scope.id, status: "retired", saidBy: "user", source: answer.id, thread: thread.id }],
		});

		const stored = {
			persons: await send({ type: "person", action: "list" }),
			threads: await send({ type: "thread", action: "list" }),
			read: await send({ type: "thread", action: "read", id: thread.id }),
			rules: await send({ type: "rule", action: "list" }),
		};

		expect(stored.read).toEqual({ thread: { ...thread, last: answer.at }, messages: [asked, answer] });
		expect(stored.rules).toMatchObject({
			rules: [
				{ id: scope.id, status: "retired" },
				{ id: ask.id, status: "decided", saidBy: sam.id },
				{ id: wider.id, status: "decided" },
			],
		});

		await host?.close();
		host = await startHost();

		expect({
			persons: await send({ type: "person", action: "list" }),
			threads: await send({ type: "thread", action: "list" }),
			read: await send({ type: "thread", action: "read", id: thread.id }),
			rules: await send({ type: "rule", action: "list" }),
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
			[noSource, "Invalid rule request: source: required"],
			[noAuthor, "Invalid rule request: saidBy: required"],
			[noName, "Invalid rule request: name: required"],
			[{ ...newRule, name: " " }, 'Invalid rule request: name: must match pattern "\\S"'],
			[
				{ type: "rule", action: "set", caller: "cli", id: rule.id, value: "x", saidBy: "user" },
				"Invalid rule request: source: required",
			],
			[{ ...newRule, status: "decided" }, "Invalid rule request: status: not allowed"],
			[{ ...newRule, id: rule.id, status: "retired" }, "Invalid rule request: status: not allowed"],
			[{ type: "rule", action: "decide", caller: "cli" }, "Invalid rule request: id: required"],
			[
				{ type: "rule", action: "create", caller: "cli", name: "x", kind: "domain" },
				"Invalid rule request: value: required",
			],
			[{ type: "term", action: "list" }, 'no loaded entry serves request type "term"'],
			[
				{ type: "term", action: "set", caller: "cli", name: "x", meaning: "y", saidBy: "user" },
				'no loaded entry serves request type "term"',
			],
			[{ type: "part", action: "list" }, 'no loaded entry serves request type "part"'],
			[
				{ type: "part", action: "add", caller: "cli", kind: "table", path: "x.md", rules: [], terms: [] },
				'no loaded entry serves request type "part"',
			],
			[
				{ type: "thread", action: "add", topic: "No one", persons: [] },
				"Invalid thread request: persons: must not have fewer than 1 items",
			],
			[{ type: "person", action: "add", name: " " }, 'Invalid person request: name: must match pattern "\\S"'],
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
		await expect(send({ ...rule2, saidBy: 99, source: message.id })).rejects.toThrow("Unknown person: 99");
		await expect(send({ ...rule2, source: message.id, replaces: 99 })).rejects.toThrow("Unknown rule: 99");
		await expect(
			send({
				type: "rule",
				action: "set",
				caller: "cli",
				id: 99,
				value: "x",
				saidBy: "user",
				source: message.id,
			}),
		).rejects.toThrow("Unknown rule: 99");

		for (const action of ["decide", "retire", "delete", "edit"] as const) {
			await expect(send({ type: "rule", action, caller: "cli", id: 99 })).rejects.toThrow("Unknown rule: 99");
		}

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

			const add = async (name: string, kind: "conduct" | "domain", status: "open" | "decided" | "retired") => {
				const { id } = Value.Parse(Rule, await send({ ...said, name, kind, value: `The rule ${name}.` }, "rules"));

				if (status === "decided") await send({ type: "rule", action: "decide", caller: "user", id }, "rules");

				if (status === "retired") await send({ type: "rule", action: "retire", caller: "user", id }, "rules");

				return id;
			};

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

	it("lets an agent change only an open rule, and the user decide, retire, edit, create and delete a rule", async () => {
		const project = "user-rules";
		const dir = await mkdtemp(join(root, `${project}-`));
		expect((await cli(["create", project, "--cwd", dir])).code).toBe(0);

		const run = async () => {
			const found = await runHost({ project, cwd: dir, models });

			if (found === undefined) throw new Error("no host");

			return found;
		};

		let started = await run();

		try {
			const person = Value.Parse(Person, await send({ type: "person", action: "add", name: "Lea" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Rules", persons: [person.id] }, project),
			);

			const log = { type: "message", action: "log", caller: "cli", thread: thread.id, from: "user" } as const;
			const source = (await send({ ...log, direction: "out", text: "Rules." }, project)).id;
			const said = { type: "rule", action: "set", caller: "agent", saidBy: "user", source } as const;
			const old = Value.Parse(Rule, await send({ ...said, name: "old", kind: "domain", value: "Old." }, project));

			const next = Value.Parse(
				Rule,
				await send({ ...said, name: "new", kind: "domain", value: "New.", replaces: old.id }, project),
			);

			expect(next).toMatchObject({ source, thread: thread.id });

			// A changed source gives the thread of the new source.
			const other = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Other", persons: [person.id] }, project),
			);

			const otherSource = (await send({ ...log, thread: other.id, direction: "out", text: "Other." }, project)).id;

			expect(await send({ ...said, id: next.id, source: otherSource }, project)).toMatchObject({
				id: next.id,
				source: otherSource,
				thread: other.id,
			});

			const decide = { type: "rule", action: "decide", caller: "user" } as const;
			await send({ ...decide, id: old.id }, project);

			// An agent changes an open rule only, and the user decides an open rule only.
			await expect(send({ ...said, id: old.id, value: "Changed." }, project)).rejects.toThrow(
				`Rule ${old.id} is decided, not open`,
			);
			await expect(send({ ...decide, id: old.id }, project)).rejects.toThrow(`Rule ${old.id} is decided, not open`);
			// The decide of the new rule retires the rule that it replaces.
			expect(await send({ ...decide, id: next.id }, project)).toMatchObject({ id: next.id, status: "decided" });
			expect(await send({ type: "rule", action: "list", status: "retired" }, project)).toMatchObject({
				rules: [{ id: old.id, saidBy: "user", source, by: "user" }],
			});
			await expect(send({ type: "rule", action: "retire", caller: "user", id: old.id }, project)).rejects.toThrow(
				`Rule ${old.id} is retired`,
			);

			// An edit of the user keeps the status, and makes the user its author with no source.
			const edited = await cli(["--project", project, "rule", "edit", String(next.id), "--value", "Newer."]);
			expect(edited).toEqual({
				code: 0,
				stdout: `${next.id} new (domain, decided): Newer. [said by user; replaces ${old.id}]\n`,
				stderr: "",
			});

			const created = await cli([
				"--project",
				project,
				"rule",
				"create",
				"--name",
				"go",
				"--kind",
				"conduct",
				"--value",
				"Ask first.",
			]);

			expect(created.stdout).toBe(`${next.id + 1} go (conduct, decided): Ask first. [said by user]\n`);
			const stored = Value.Parse(RuleList, await send({ type: "rule", action: "list" }, project)).rules;
			expect(stored.find((rule) => rule.id === next.id)).not.toHaveProperty("source");
			expect(stored.find((rule) => rule.id === next.id)).not.toHaveProperty("thread");

			// A delete removes the rule, and its ID is never given again, also after a restart.
			const deleted = await cli(["--project", project, "rule", "delete", String(next.id + 1)]);
			expect(deleted.code).toBe(0);
			await started.close();
			started = await run();

			expect(await send({ type: "rule", action: "list" }, project)).toMatchObject({
				rules: [{ id: old.id }, { id: next.id }],
			});

			const third = await send({ ...said, name: "third", kind: "domain", value: "Third.", replaces: next.id }, project);
			expect(third).toMatchObject({ id: next.id + 2, status: "open" });
			await send({ type: "rule", action: "delete", caller: "user", id: next.id }, project);
			// A decide of a rule whose replaced rule went retires nothing.
			expect(await send({ ...decide, id: next.id + 2 }, project)).toMatchObject({ status: "decided" });
			expect(await send({ type: "rule", action: "list" }, project)).toMatchObject({
				rules: [
					{ id: old.id, status: "retired" },
					{ id: next.id + 2, status: "decided" },
				],
			});
			expect((await cli(["--project", project, "rule", "decide", "0"])).stderr).toBe("Invalid rule id: 0\n");
			expect((await cli(["--project", project, "rule", "retire", "99"])).stderr).toBe("Unknown rule: 99\n");
		} finally {
			await started.close();
		}
	});

	it("stores only the fields of a rule for a create and an edit of the user", async () => {
		const project = "user-rule-fields";
		const started = await projectHost(project);

		try {
			const fields = { type: "rule", action: "create", name: "a", kind: "domain", value: "A." } as const;
			await send({ ...fields, caller: "cli" }, project);
			const at = expect.any(Number);
			const created = { id: 1, name: "a", kind: "domain", value: "A.", status: "decided", saidBy: "user", at };
			expect(await send({ type: "rule", action: "list" }, project)).toEqual({ rules: [{ ...created, by: "cli" }] });

			await send({ type: "rule", action: "edit", caller: "cli2", id: 1, value: "B." }, project);

			expect(await send({ type: "rule", action: "list" }, project)).toEqual({
				rules: [{ ...created, value: "B.", by: "cli2" }],
			});
		} finally {
			await started.close();
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

			const item = Value.Parse(
				WorkItem,
				await send({ type: "item", action: "add", caller: "cli", title: "Poll the items" }, "idle-store"),
			);

			const polling = (async () => {
				while (!closed) {
					await send({ type: "rule", action: "list" }, "idle-store").catch(() => undefined);
					await send({ type: "thread", action: "read", id: thread.id }, "idle-store").catch(() => undefined);
					await send({ type: "item", action: "list" }, "idle-store").catch(() => undefined);
					await send({ type: "item", action: "read", id: item.id }, "idle-store").catch(() => undefined);
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			})();

			await until(() => closed);
			await polling;
		} finally {
			await idle.close();
		}
	});

	it("edits and deletes a message, logs a message out as sent, and adds a person to a thread, also after a restart", async () => {
		const project = "edits";
		const dir = await mkdtemp(join(root, `${project}-`));
		expect((await cli(["create", project, "--cwd", dir])).code).toBe(0);
		let edits = await runHost({ project, cwd: dir, models });

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));
			const rufin = Value.Parse(Person, await send({ type: "person", action: "add", name: "Rufin" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
			);

			const joined = { ...thread, persons: [sam.id, rufin.id] };
			expect(await send({ type: "thread", action: "join", id: thread.id, person: rufin.id }, project)).toEqual(joined);

			const draft = await logAt(project, thread.id, "user", 2_000, "Types 45 and 54.");
			const asked = await logAt(project, thread.id, sam.id, 1_000, "Which types?");

			const sentLine = {
				type: "message",
				action: "log",
				caller: "cli",
				thread: thread.id,
				from: "user",
				direction: "out",
				at: 3_000,
				text: "Type 56 too.",
				state: "sent",
			} as const;

			const sent = Value.Parse(Message, await send(sentLine, project));
			expect(sent).toMatchObject({ direction: "out", state: "sent", at: 3_000 });

			const edit = { type: "message", action: "edit", caller: "editor" } as const;

			// An edit keeps the ID and the state, and an earlier time lowers the last time of the thread.
			const earlier = await send({ ...edit, message: sent.id, text: "Type 56 as well.", at: 1_500 }, project);
			expect(earlier).toEqual({ ...sent, text: "Type 56 as well.", at: 1_500, by: "editor" });

			const read = async () => ({
				thread: await send({ type: "thread", action: "read", id: thread.id }, project),
				rules: await send({ type: "rule", action: "list" }, project),
			});

			expect((await read()).thread).toEqual({
				thread: { ...joined, last: draft.at },
				messages: [draft, asked, earlier],
			});

			// Each object is one row of its table, and the edit changed the row of the message in its place.
			expect(storeRows(project, "SELECT id, name FROM person")).toEqual([sam, rufin]);
			expect(storeRows(project, "SELECT id, topic, last FROM thread")).toEqual([
				{ id: thread.id, topic: "Scope", last: draft.at },
			]);
			expect(storeRows(project, "SELECT thread, person FROM thread_person ORDER BY rowid")).toEqual([
				{ thread: thread.id, person: sam.id },
				{ thread: thread.id, person: rufin.id },
			]);
			expect(storeRows(project, "SELECT id, person, state, at, text FROM message ORDER BY rowid")).toEqual([
				{ id: draft.id, person: null, state: "draft", at: 2_000, text: draft.text },
				{ id: asked.id, person: sam.id, state: "received", at: 1_000, text: asked.text },
				{ id: sent.id, person: null, state: "sent", at: 1_500, text: "Type 56 as well." },
			]);

			// A message out that gets a person as its author becomes a message in, and a message in that gets the user a draft.
			const turnedIn = await send({ ...edit, message: draft.id, text: draft.text, from: rufin.id }, project);
			expect(turnedIn).toEqual({ ...draft, from: rufin.id, direction: "in", state: "received", by: "editor" });
			const turnedOut = await send({ ...edit, message: asked.id, text: "Which types, Sam?", from: "user" }, project);

			expect(turnedOut).toEqual({
				...asked,
				from: "user",
				direction: "out",
				state: "draft",
				text: "Which types, Sam?",
				by: "editor",
			});

			const rule = Value.Parse(
				Rule,
				await send(
					{
						type: "rule",
						action: "set",
						caller: "cli",
						name: "scope",
						kind: "domain",
						value: "Types 45 and 54.",
						saidBy: rufin.id,
						source: turnedIn.id,
					},
					project,
				),
			);

			const before = await read();
			const remove = { type: "message", action: "delete", caller: "editor" } as const;

			const failures: readonly (readonly [() => Promise<Replies["message" | "thread"]>, string])[] = [
				[() => send({ ...edit, message: 999_999, text: "x" }, project), "Unknown message: 999999"],
				[
					() => send({ ...edit, message: sent.id, text: "x", from: 99 }, project),
					`Person 99 is not in thread ${thread.id}`,
				],
				[() => send({ ...remove, message: 999_999 }, project), "Unknown message: 999999"],
				[
					() => send({ ...remove, message: turnedIn.id }, project),
					`Message ${turnedIn.id} is the source of rule ${rule.id}`,
				],
				[
					() => send({ ...sentLine, from: sam.id, direction: "in" }, project),
					"Only a message out can be logged as sent",
				],
				[
					() => send<"message">(JSON.parse(JSON.stringify({ ...sentLine, state: "draft" })), project),
					"Invalid message request: state: must be equal to constant",
				],
				[
					() => send({ type: "thread", action: "join", id: thread.id, person: rufin.id }, project),
					`Person ${rufin.id} is already in thread ${thread.id}`,
				],
				[
					() => send({ type: "thread", action: "join", id: 999_999, person: sam.id }, project),
					"Unknown thread: 999999",
				],
				[() => send({ type: "thread", action: "join", id: 999_999, person: 99 }, project), "Unknown person: 99"],
			];

			for (const [failure, error] of failures) await expect(failure()).rejects.toThrow(error);
			expect(await read()).toEqual(before);

			// A retired rule loses the source that a delete removes, and keeps its time and its caller.
			const retired = await send({ type: "rule", action: "retire", caller: "user", id: rule.id }, project);
			const { source: _source, thread: _thread, ...unsourced } = Value.Parse(Rule, retired);
			expect(await send({ ...remove, message: turnedIn.id }, project)).toEqual(turnedIn);
			expect(await send({ ...remove, message: earlier.id }, project)).toEqual(earlier);

			const after = await read();

			expect(after).toEqual({
				thread: { thread: { ...joined, last: asked.at }, messages: [turnedOut] },
				rules: { rules: [unsourced] },
			});

			// A delete removes the row of the message, and the retired rule keeps its row with no source.
			expect(storeRows(project, "SELECT id FROM message")).toEqual([{ id: turnedOut.id }]);
			expect(storeRows(project, "SELECT id, status, source, thread FROM rule")).toEqual([
				{ id: rule.id, status: "retired", source: null, thread: null },
			]);

			await edits?.close();
			edits = await runHost({ project, cwd: dir, models });
			expect(await read()).toEqual(after);

			const gone = [
				() => send({ type: "message", action: "mark", caller: "cli", message: earlier.id, state: "dropped" }, project),
				() => send({ ...edit, message: earlier.id, text: "x" }, project),
				() => send({ ...remove, message: earlier.id }, project),
			];

			for (const failure of gone) await expect(failure()).rejects.toThrow(`Unknown message: ${earlier.id}`);

			// The thread of no message has no last time.
			expect(await send({ ...remove, message: turnedOut.id }, project)).toEqual(turnedOut);
			expect((await read()).thread).toEqual({ thread: joined, messages: [] });
		} finally {
			await edits?.close();
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
				"Invalid message request: state: must be equal to one of the allowed values",
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

			const both = (at: number) =>
				`board of digest: 0 open\nwaiting on: ${sent(at)} · Benoit (double loyalty, draft not sent)\nheld: none`;

			expect([before, after].map(both)).toContain(await digestOf(project, "pi-1"));
			expect(await digestOf(project, "pi-1")).toBeUndefined();

			await send({ ...mark, message: toBenoit.id, state: "dropped" }, project);
			const samOnly = (at: number) => `board of digest: 0 open\nwaiting on: ${sent(at)}\nheld: none`;
			expect([before, after].map(samOnly)).toContain(await digestOf(project, "pi-1"));
			// Each caller has its own last digest.
			expect([before, after].map(samOnly)).toContain(await digestOf(project, "pi-2"));

			await logAt(project, brand.id, sam.id, 2_000, "Thanks.");
			expect(await digestOf(project, "pi-1")).toBe("board of digest: 0 open\nwaiting on: none\nheld: none");
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
			const waiting = "board of digest-child: 0 open\nwaiting on: Sam (Scope, draft not sent)\nheld: none";
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
				"board of digest-child: 0 open\nwaiting on: none\nheld: none",
				"Digest three",
			]);
		} finally {
			await digests.close();
		}
	});

	it("gives a running child the decided rules as a section of its system prompt at its next request", async () => {
		const project = "rules-child";
		const rules = await projectHost(project);

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Rules", persons: [sam.id] }, project),
			);

			const said = await logAt(project, thread.id, sam.id, 1_000, "Use tabs.");
			const child = await spawnAs("rules-test", "Rules one", { notify: false, project });
			await answerOf(child.handle, project);
			expect(requests.get("Rules one")?.sections).not.toHaveProperty("project_rules");

			const line = {
				type: "send",
				caller: "rules-test",
				handle: child.handle,
				followUp: false,
				notify: false,
			} as const;

			const set = { type: "rule", action: "set", caller: "cli", saidBy: sam.id, source: said.id } as const;
			await send({ ...set, name: "tabs", kind: "domain", value: "The code uses tabs." }, project);
			await send({ ...line, requestId: "two", message: "Rules two" }, project);
			await answerOf(child.handle, project);
			expect(requests.get("Rules two")?.sections).not.toHaveProperty("project_rules");

			await send({ type: "rule", action: "decide", caller: "cli", id: 1 }, project);
			await send({ ...line, requestId: "three", message: "Rules three" }, project);
			await answerOf(child.handle, project);
			expect(requests.get("Rules three")?.sections.project_rules).toBe(
				`<project_rules>\n${RULES_HEAD}\n1 tabs (domain): The code uses tabs.\n</project_rules>`,
			);

			await send({ type: "rule", action: "retire", caller: "cli", id: 1 }, project);
			await send({ ...line, requestId: "four", message: "Rules four" }, project);
			await answerOf(child.handle, project);
			expect(requests.get("Rules four")?.sections).not.toHaveProperty("project_rules");
		} finally {
			await rules.close();
		}
	});

	it("makes the section of the rules from the decided rules only, conduct first, and none with no decided rule", () => {
		const base = { saidBy: "user", at: 1, by: "cli" } as const;
		const decided = { ...base, status: "decided" } as const;

		const list: Rule[] = [
			{ ...decided, id: 1, name: "fact", kind: "domain", value: "A fact." },
			{ ...base, id: 2, name: "draft", kind: "conduct", value: "Not yet.", status: "open" },
			{ ...decided, id: 4, name: "late", kind: "conduct", value: "Ask later." },
			{ ...decided, id: 3, name: "ask", kind: "conduct", value: "Ask first." },
			{ ...base, id: 5, name: "old", kind: "domain", value: "Gone.", status: "retired" },
		];

		expect(rulesSection(list)).toBe(
			`${RULES_HEAD}\n3 ask (conduct): Ask first.\n4 late (conduct): Ask later.\n1 fact (domain): A fact.`,
		);
		expect(rulesSection(list.filter((rule) => rule.status !== "decided"))).toBeUndefined();
		expect(rulesSection([])).toBeUndefined();
	});
});
