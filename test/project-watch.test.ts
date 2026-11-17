import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { CommitObserver } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { sessionDoc } from "../src/host/project-docs.ts";
import { projectEvent } from "../src/host/project-watch.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { type StoreView, serveStoreWatch } from "../src/host/store-watch.ts";
import { onLines } from "../src/protocol/lines.ts";
import { statePaths } from "../src/protocol/paths.ts";
import {
	Ask,
	AskWrite,
	type HeldAction,
	Message,
	Person,
	ProjectEvent,
	ProjectState,
	Rule,
	RULES_KIND,
	Thread,
} from "../src/protocol/project.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { cli, models, openDurableHost, readStoreFile, root, setUp, tearDown, until, watchProject } from "./helpers.ts";

/** The documents of the terms and of the parts of the vault, as an older version kept them in the store. */
const OLD_TERMS = sessionDoc<{ terms: JsonValue[] }>("harness.terms", () => ({ terms: [] }));
const OLD_PARTS = sessionDoc<{ parts: JsonValue[] }>("harness.parts", () => ({ parts: [] }));

/** The document of the rules, as an older version kept it in the store: with no `last`. */
const OLD_RULES = sessionDoc<{ rules: JsonValue[] }>(RULES_KIND, () => ({ rules: [] }));

const NONE: ProjectEvent["removed"] = {
	persons: [],
	rules: [],
	threads: [],
	held: [],
	parleys: [],
	asks: [],
};

/** An event with the objects of `changes`, no other object, and no removed ID. */
function event(changes: Partial<ProjectEvent>): ProjectEvent {
	return {
		persons: [],
		rules: [],
		threads: [],
		held: [],
		parleys: [],
		asks: [],
		removed: NONE,
		degraded: [],
		...changes,
	};
}

/** Runs the host of the new project `name` in this process. */
async function projectHost(name: string): Promise<Host> {
	const dir = await mkdtemp(join(root, `${name}-`));
	expect((await cli(["create", name, "--cwd", dir])).code).toBe(0);
	const host = await runHost({ project: name, cwd: dir, models });

	if (host === undefined) throw new Error("no host");

	return host;
}

/** Sends `line` to the host of `project` through the socket. */
async function send<T extends Request["type"]>(
	line: Extract<Request, { type: T }>,
	project: string,
): Promise<Replies[T]> {
	const reply = await request(line, { start: false, project });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

beforeAll(async () => {
	await setUp();
});

afterAll(async () => {
	await tearDown();
});

describe("watch-project", { timeout: 60_000 }, () => {
	it("sends one event with the objects that each commit changed, and the messages that wait in each thread", async () => {
		const project = "watched";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			watch = await watchProject(project);
			const { events } = watch;
			expect(watch.state).toEqual({
				persons: [],
				rules: [],
				threads: [],
				held: [],
				parleys: [],
				asks: [],
				degraded: [],
			});

			/** Waits for the next event, and gives it. */
			const next = async (): Promise<ProjectEvent | undefined> => {
				const count = events.length;
				await until(() => events.length > count);
				expect(events.length).toBe(count + 1);

				return events.at(-1);
			};

			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));
			expect(await next()).toEqual(event({ persons: [sam] }));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
			);

			expect(await next()).toEqual(event({ threads: [{ ...thread, waits: [] }] }));

			const asked = Value.Parse(
				Message,
				await send(
					{
						type: "message",
						action: "log",
						caller: "cli",
						thread: thread.id,
						from: sam.id,
						direction: "in",
						at: 1_000,
						text: "Which sale types?",
					},
					project,
				),
			);

			expect(await next()).toEqual(event({ threads: [{ ...thread, last: asked.at, waits: [] }] }));

			const draft = Value.Parse(
				Message,
				await send(
					{
						type: "message",
						action: "log",
						caller: "cli",
						thread: thread.id,
						from: "user",
						direction: "out",
						text: "45 and 54.",
					},
					project,
				),
			);

			expect(await next()).toEqual(event({ threads: [{ ...thread, last: draft.at, waits: [draft] }] }));

			// A mark changes the outbox, not the entry of the message: the thread gives the message with its new state.
			const sent = Value.Parse(
				Message,
				await send({ type: "message", action: "mark", caller: "cli", message: draft.id, state: "sent" }, project),
			);

			expect(sent).toEqual({ ...draft, state: "sent" });
			expect(await next()).toEqual(event({ threads: [{ ...thread, last: draft.at, waits: [sent] }] }));

			const rule = Value.Parse(
				Rule,
				await send(
					{
						type: "rule",
						action: "set",
						caller: "cli",
						name: "scope",
						kind: "domain",
						value: "Sale types 45 and 54.",
						saidBy: "user",
						source: draft.id,
					},
					project,
				),
			);

			expect(await next()).toEqual(event({ rules: [rule] }));

			const decided = Value.Parse(
				Rule,
				await send({ type: "rule", action: "decide", caller: "cli", id: rule.id }, project),
			);

			expect(await next()).toEqual(event({ rules: [decided] }));

			// A commit that changes no object of the project sends no event.
			await send(
				{ type: "todo", caller: "cli", action: "add", handle: AGENT_HANDLE, text: "Check the scope" },
				project,
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(events).toHaveLength(7);

			const again = await watchProject(project);
			again.socket.destroy();

			expect(again.state).toEqual({
				persons: [sam],
				rules: [decided],
				threads: [{ ...thread, last: draft.at, waits: [sent] }],
				held: [],
				parleys: [],
				asks: [],
				degraded: [],
			});
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("opens a store with the terms and parts documents of an older version, and gives no terms and no parts", async () => {
		const project = "older";
		const dir = await mkdtemp(join(root, `${project}-`));
		expect((await cli(["create", project, "--cwd", dir])).code).toBe(0);
		let host = await runHost({ project, cwd: dir, models });
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
			);

			const asked = Value.Parse(
				Message,
				await send(
					{
						type: "message",
						action: "log",
						caller: "cli",
						thread: thread.id,
						from: sam.id,
						direction: "in",
						at: 1_000,
						text: "Which types?",
					},
					project,
				),
			);

			const rule = Value.Parse(
				Rule,
				await send(
					{
						type: "rule",
						action: "set",
						caller: "cli",
						name: "scope",
						kind: "domain",
						value: "45 and 54.",
						saidBy: sam.id,
						source: asked.id,
					},
					project,
				),
			);

			await host?.close();
			// An older version kept the terms and the parts of the vault in these documents of the store.
			const older = await openDurableHost(join(statePaths(project).dir, "durable.sqlite"), []);
			const term = { id: 1, name: "mandat", meaning: "A signed order.", avoid: [], saidBy: "user", source: asked.id };

			const part = {
				id: 1,
				kind: "table",
				path: "Scope.md",
				rules: [rule.id],
				terms: [1],
				checked: 1_000,
				stale: true,
			};

			await older.commit(async (tx) => {
				(await tx.doc(OLD_TERMS)).terms.push({ ...term, at: 1_000, by: "cli" });
				(await tx.doc(OLD_PARTS)).parts.push({ ...part, by: "cli" });
			}, BACKGROUND_CONTEXT);
			await older.close(BACKGROUND_CONTEXT);

			host = await runHost({ project, cwd: dir, models });
			watch = await watchProject(project);

			expect(watch.state).toEqual({
				persons: [sam],
				rules: [rule],
				threads: [{ ...thread, last: asked.at, waits: [] }],
				held: [],
				parleys: [],
				asks: [],
				degraded: [],
			});
			expect(await send({ type: "rule", action: "list" }, project)).toEqual({ rules: [rule] });
		} finally {
			watch?.socket.destroy();
			await host?.close();
		}
	});

	it("never gives again the ID of a deleted rule of a store with no last ID", async () => {
		const project = "no-last";
		const dir = await mkdtemp(join(root, `${project}-`));
		expect((await cli(["create", project, "--cwd", dir])).code).toBe(0);
		let host = await runHost({ project, cwd: dir, models });

		try {
			await host?.close();
			const older = await openDurableHost(join(statePaths(project).dir, "durable.sqlite"), []);
			const fields = { kind: "domain", status: "decided", saidBy: "user", at: 1_000, by: "cli" };

			await older.commit(async (tx) => {
				const list = await tx.doc(OLD_RULES);
				list.rules.push({ ...fields, id: 1, name: "a", value: "A." }, { ...fields, id: 2, name: "b", value: "B." });
			}, BACKGROUND_CONTEXT);
			await older.close(BACKGROUND_CONTEXT);

			host = await runHost({ project, cwd: dir, models });
			await send({ type: "rule", action: "delete", caller: "cli", id: 2 }, project);
			const create = { type: "rule", action: "create", caller: "cli", name: "c", kind: "domain", value: "C." } as const;
			expect(await send(create, project)).toMatchObject({ id: 3 });
		} finally {
			await host?.close();
		}
	});

	it("gives the thread of the source of a rule that an older store wrote with no thread", async () => {
		const project = "no-thread";
		const dir = await mkdtemp(join(root, `${project}-`));
		expect((await cli(["create", project, "--cwd", dir])).code).toBe(0);
		let host = await runHost({ project, cwd: dir, models });
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
			);

			const said = Value.Parse(
				Message,
				await send(
					{
						type: "message",
						action: "log",
						caller: "cli",
						thread: thread.id,
						from: "user",
						direction: "out",
						text: "45 and 54.",
					},
					project,
				),
			);

			await host?.close();
			const older = await openDurableHost(join(statePaths(project).dir, "durable.sqlite"), []);
			const fields = { kind: "domain", status: "decided", saidBy: "user", at: 1_000, by: "cli" };

			await older.commit(async (tx) => {
				const list = await tx.doc(OLD_RULES);
				list.rules.push(
					{ ...fields, id: 1, name: "scope", value: "45 and 54.", source: said.id },
					{ ...fields, id: 2, name: "user", value: "Ask first." },
				);
			}, BACKGROUND_CONTEXT);
			await older.close(BACKGROUND_CONTEXT);

			host = await runHost({ project, cwd: dir, models });

			const rules = [
				{ ...fields, id: 1, name: "scope", value: "45 and 54.", source: said.id, thread: thread.id },
				{ ...fields, id: 2, name: "user", value: "Ask first." },
			];

			expect(await send({ type: "rule", action: "list" }, project)).toEqual({ rules });
			watch = await watchProject(project);
			expect(watch.state.rules).toEqual(rules);
			await until(() => readStoreFile(project)?.rules.length === 2);
			expect(readStoreFile(project)?.rules).toEqual(rules);
		} finally {
			watch?.socket.destroy();
			await host?.close();
		}
	});

	it("gives the new source of a changed rule with the thread of that source", async () => {
		const project = "moved-source";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

			/** Adds a thread with Sam and one message in it, and gives the thread and the message. */
			const said = async (topic: string): Promise<[Thread, Message]> => {
				const thread = Value.Parse(
					Thread,
					await send({ type: "thread", action: "add", topic, persons: [sam.id] }, project),
				);

				const message = Value.Parse(
					Message,
					await send(
						{
							type: "message",
							action: "log",
							caller: "cli",
							thread: thread.id,
							from: sam.id,
							direction: "in",
							text: topic,
						},
						project,
					),
				);

				return [thread, message];
			};

			const [first, firstMessage] = await said("Scope");
			const [second, secondMessage] = await said("Scope again");
			const fields = { caller: "cli", name: "scope", kind: "domain", value: "45 and 54.", saidBy: sam.id } as const;

			const rule = Value.Parse(
				Rule,
				await send({ type: "rule", action: "set", ...fields, source: firstMessage.id }, project),
			);

			expect(rule.thread).toBe(first.id);
			watch = await watchProject(project);
			const { events } = watch;

			const changed = Value.Parse(
				Rule,
				await send({ type: "rule", action: "set", ...fields, id: rule.id, source: secondMessage.id }, project),
			);

			await until(() => events.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(events).toEqual([event({ rules: [changed] })]);
			expect(changed).toMatchObject({ id: rule.id, source: secondMessage.id, thread: second.id });
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("gives the rule that the user creates, and the ID of the rule that the user deletes", async () => {
		const project = "deleted";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			watch = await watchProject(project);
			const { events } = watch;
			const create = { type: "rule", action: "create", caller: "cli", name: "go", kind: "conduct" } as const;
			const rule = Value.Parse(Rule, await send({ ...create, value: "Ask first." }, project));
			expect(rule).toMatchObject({ id: 1, status: "decided", saidBy: "user" });
			await until(() => events.length === 1);
			expect(events[0]).toEqual(event({ rules: [rule] }));

			await send({ type: "rule", action: "delete", caller: "cli", id: rule.id }, project);
			await until(() => events.length === 2);
			expect(events[1]).toEqual(event({ removed: { ...NONE, rules: [rule.id] } }));
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("gives the thread of a join, of an edit of a draft and of a delete of a draft", async () => {
		const project = "watched-edit";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));
			const rufin = Value.Parse(Person, await send({ type: "person", action: "add", name: "Rufin" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Scope", persons: [sam.id] }, project),
			);

			watch = await watchProject(project);
			const { events } = watch;

			const joined = Value.Parse(
				Thread,
				await send({ type: "thread", action: "join", id: thread.id, person: rufin.id }, project),
			);

			expect(joined).toEqual({ ...thread, persons: [sam.id, rufin.id] });
			await until(() => events.length === 1);
			expect(events[0]).toEqual(event({ threads: [{ ...joined, waits: [] }] }));

			const log = { type: "message", action: "log", caller: "cli", thread: thread.id, from: "user" } as const;
			const draft = Value.Parse(Message, await send({ ...log, direction: "out", at: 1_000, text: "45." }, project));
			await until(() => events.length === 2);

			const edited = Value.Parse(
				Message,
				await send(
					{ type: "message", action: "edit", caller: "cli", message: draft.id, text: "45 and 54.", at: 2_000 },
					project,
				),
			);

			await until(() => events.length === 3);
			expect(events[2]).toEqual(event({ threads: [{ ...joined, last: 2_000, waits: [edited] }] }));

			await send({ type: "message", action: "delete", caller: "cli", message: draft.id }, project);
			await until(() => events.length === 4);
			expect(events[3]).toEqual(event({ threads: [{ ...joined, waits: [] }] }));
			// Each commit gives one event.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(events).toHaveLength(4);
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("gives a new parley, a changed parley and their asks", async () => {
		const project = "watched-parley";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			watch = await watchProject(project);
			const { events } = watch;

			const next = async (): Promise<ProjectEvent | undefined> => {
				const count = events.length;
				await until(() => events.length > count);
				expect(events.length).toBe(count + 1);

				return events.at(-1);
			};

			const round = Value.Parse(
				AskWrite,
				await send(
					{
						type: "ask",
						action: "round",
						caller: "pi-1",
						parley: { slug: "store", title: "The store", goal: "Keep the asks." },
						asks: [{ title: "Where", options: [{ key: "a", label: "Here" }], plan: "a" }],
					},
					project,
				),
			);

			const [store] = round.parleys;

			if (store === undefined) throw new Error("no parley");
			expect(await next()).toEqual(event({ parleys: [store.parley], asks: store.asks }));

			const second = Value.Parse(
				AskWrite,
				await send(
					{
						type: "ask",
						action: "round",
						caller: "pi-1",
						parley: { slug: "store", design_sense: "One writer." },
						asks: [{ title: "These are the terms" }],
					},
					project,
				),
			);

			// The parley changed and got an ask; the first ask did not change.
			const [changed] = second.parleys;

			if (changed === undefined) throw new Error("no parley");
			expect(changed.parley).toMatchObject({ id: 1, design_sense: "One writer." });
			expect(await next()).toEqual(event({ parleys: [changed.parley], asks: changed.asks.slice(1) }));

			const answer = Value.Parse(
				AskWrite,
				await send({ type: "ask", action: "answer", caller: "user", answers: [{ id: 1, answer: "a" }] }, project),
			);

			// The answer waits for pi-1, which has no answers request open: a degraded state, with the commit or after it.
			const waits = {
				kind: "answer-waits",
				line: "The answers of the user wait for pi-1, which has no answers request open",
				since: expect.any(Number),
			} as const;

			const count = events.length;
			await until(() => events.at(-1)?.degraded.length === 1);
			const answered = answer.parleys.flatMap((each) => each.asks.slice(0, 1));
			expect(events.slice(count).find((found) => found.asks.length > 0)).toEqual({
				...event({ asks: answered }),
				degraded: expect.any(Array),
			});
			expect(events.at(-1)?.degraded).toEqual([waits]);
			expect(answer.parleys[0]?.asks[0]).toMatchObject({ author: { kind: "agent", caller: "user" } });

			const noted = Value.Parse(
				Ask,
				await send({ type: "ask", action: "note", caller: "pi-1", slug: "store", n: 1, note: "store-1" }, project),
			);

			expect(noted).toMatchObject({ id: 1, note: "store-1", by: "pi-1", author: { kind: "agent", caller: "user" } });
			expect(await next()).toEqual(event({ asks: [noted], degraded: [waits] }));
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("sends every object once to a watch that fell behind", async () => {
		const project = "slow-project";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Large", persons: [sam.id] }, project),
			);

			watch = await watchProject(project);
			const { events, socket } = watch;
			const large = "x".repeat(1_000_000);

			// The client reads nothing, so the host waits for the socket to drain after the event of the large draft.
			socket.pause();
			await send(
				{
					type: "message",
					action: "log",
					caller: "cli",
					thread: thread.id,
					from: "user",
					direction: "out",
					text: large,
				},
				project,
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			await send({ type: "person", action: "add", name: "Rufin" }, project);
			await new Promise((resolve) => setTimeout(resolve, 300));
			socket.resume();

			const index = () => events.findIndex((found) => JSON.stringify(found).includes(large));
			await until(() => index() !== -1 && events.length > index() + 1);
			const all = await watchProject(project);
			all.socket.destroy();
			expect(events.slice(index() + 1)).toEqual([{ ...all.state, removed: NONE }]);
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("ends the connection of a watch at the close of the host", async () => {
		const project = "closed-project";
		const host = await projectHost(project);
		const watch = await watchProject(project);

		try {
			const closed = once(watch.socket, "close");
			await host.close();
			await closed;
			expect(watch.socket.destroyed).toBe(true);
		} finally {
			watch.socket.destroy();
			await host.close();
		}
	});

	it("stops at the close of its socket, and ends its connection at the end of the store", async () => {
		const observers: CommitObserver[] = [];
		let detached = 0;

		const harness = {
			observeCommits: (observer: CommitObserver) => {
				observers.push(observer);

				return { detach: () => (detached += 1) };
			},
		};

		const view: StoreView<number, number> = { read: async () => 1, events: () => [], changes: () => true };
		const server = createServer();
		const path = join(root, "store-watch.sock");
		server.listen(path);
		await once(server, "listening");

		/** A watch of `view` on a new connection: the client socket, and the abort that the close of the socket gives. */
		const open = async (): Promise<{ client: Socket; aborted: Promise<unknown> }> => {
			const accepted = once(server, "connection");
			const client = createConnection(path);
			const [socket] = await accepted;

			if (!(socket instanceof Socket)) throw new Error("no socket");
			const abort = new AbortController();
			socket.on("close", () => abort.abort());
			const aborted = once(abort.signal, "abort");
			await serveStoreWatch(harness, view, abort.signal, { socket, afterReply: (run) => run(Promise.resolve(true)) });

			return { client, aborted };
		};

		try {
			const first = await open();
			first.client.destroy();
			await first.aborted;
			expect(detached).toBe(1);

			const second = await open();
			const ended = once(second.client, "end");
			observers.at(-1)?.end({ kind: "ended" });
			await ended;
			expect(detached).toBe(2);
			second.client.destroy();
		} finally {
			server.close();
		}
	});

	it("gives the messages that stopped waiting, the held actions that changed, the IDs of the objects that went, and no event when nothing changed", () => {
		const sam = { id: 1, name: "Sam" };
		const rufin = { id: 2, name: "Rufin" };

		const draft: Message = {
			id: 7,
			thread: 3,
			from: "user",
			direction: "out",
			state: "draft",
			at: 1_000,
			text: "A draft.",
			by: "cli",
		};

		const thread = { id: 3, topic: "Scope", persons: [1, 2], last: 1_000 };
		const call = { requestId: "call-1", agent: "7", tool: "bash", rule: 1, reason: "It breaks rule 1.", at: 1_000 };
		const push: HeldAction = { ...call, id: 1, command: "git push", state: "held", by: "7" };
		const merge: HeldAction = { ...call, id: 2, command: "glab mr merge 6", state: "held", by: "7" };
		const approved: HeldAction = { ...push, state: "approved", at: 2_000, by: "user" };

		const before: ProjectState = {
			persons: [sam, rufin],
			rules: [],
			threads: [{ ...thread, waits: [draft] }],
			held: [push, merge],
			parleys: [],
			asks: [],
			degraded: [],
		};

		const after: ProjectState = {
			persons: [sam],
			rules: [],
			threads: [{ ...thread, waits: [] }],
			held: [approved],
			parleys: [],
			asks: [],
			degraded: [],
		};

		expect(projectEvent(before, after, false)).toEqual(
			event({
				threads: [{ ...thread, waits: [] }],
				held: [approved],
				removed: { ...NONE, persons: [2], held: [2] },
			}),
		);
		expect(projectEvent(after, after, false)).toBeUndefined();
		expect(projectEvent(after, after, true)).toEqual(
			event({ persons: [sam], threads: [{ ...thread, waits: [] }], held: [approved] }),
		);
	});

	it("gives an event when only the degraded states change, with every degraded state, and none when they are equal", () => {
		const empty: ProjectState = { persons: [], rules: [], threads: [], held: [], parleys: [], asks: [], degraded: [] };
		const failed = { kind: "digest-failed", line: "digest: Write failed", since: 1_000 } as const;
		const skipped = { kind: "entry-skipped", line: "The entry x has no module", since: 500 } as const;

		const one: ProjectState = { ...empty, degraded: [skipped] };
		const two: ProjectState = { ...empty, degraded: [skipped, failed] };

		expect(projectEvent(one, { ...one, degraded: [{ ...skipped }] }, false)).toBeUndefined();
		expect(projectEvent(one, two, false)).toEqual(event({ degraded: [skipped, failed] }));
		expect(projectEvent(two, one, false)).toEqual(event({ degraded: [skipped] }));
		expect(projectEvent(empty, { ...empty, persons: [{ id: 1, name: "Sam" }], degraded: [] }, false)).toEqual(
			event({ persons: [{ id: 1, name: "Sam" }] }),
		);
	});

	it("runs a pass at each trigger of its view once the reply is written, and stops the triggers when it stops", async () => {
		const harness = { observeCommits: () => ({ detach: () => undefined }) };
		let trigger: (() => void) | undefined;
		let untriggered = 0;
		let reads = 0;

		const view: StoreView<number, number> = {
			read: async () => {
				reads += 1;

				return reads;
			},
			events: (_before, after) => [after],
			changes: () => false,
			triggers: (request) => {
				trigger = request;

				return () => {
					untriggered += 1;
				};
			},
		};

		const server = createServer();
		const path = join(root, "store-watch-trigger.sock");
		server.listen(path);
		await once(server, "listening");

		try {
			const accepted = once(server, "connection");
			const client = createConnection(path);
			const [socket] = await accepted;

			if (!(socket instanceof Socket)) throw new Error("no socket");
			const lines: string[] = [];
			onLines(client, (line) => lines.push(line));
			const abort = new AbortController();
			let afterReply: (() => void) | undefined;

			await serveStoreWatch(harness, view, abort.signal, {
				socket,
				afterReply: (run) => (afterReply = () => run(Promise.resolve(true))),
			});

			// A trigger before the reply is written runs no pass.
			trigger?.();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(reads).toBe(1);

			afterReply?.();
			await until(() => lines.length === 1);
			trigger?.();
			await until(() => lines.length === 2);
			expect(lines).toEqual(['{"event":2}', '{"event":3}']);

			abort.abort();
			expect(untriggered).toBe(1);
			client.destroy();
		} finally {
			server.close();
		}
	});

	it("sends the degraded state of a classify with no classifier, which commits nothing, and no event when it repeats", async () => {
		const project = "degraded-watch";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof watchProject>> | undefined;

		try {
			watch = await watchProject(project);
			const { events } = watch;
			expect(watch.state.degraded).toEqual([]);

			const line = "No classifier: log in to typesafe or set todoClassifier";
			await expect(send({ type: "classify-todos" }, project)).rejects.toThrow(line);
			await until(() => events.length === 1);
			expect(events).toEqual([event({ degraded: [{ kind: "no-classifier", line, since: expect.any(Number) }] })]);

			// The same state again changes nothing, so the next event is the one of the next commit.
			await expect(send({ type: "classify-todos" }, project)).rejects.toThrow(line);
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));
			await until(() => events.length === 2);
			expect(events[1]).toEqual(event({ persons: [sam], degraded: events[0]?.degraded ?? [] }));
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});
});
