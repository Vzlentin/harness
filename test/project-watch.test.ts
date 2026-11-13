import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { join } from "node:path";
import type { CommitObserver } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { projectEvent } from "../src/host/project-watch.ts";
import { type Host, runHost } from "../src/host/run.ts";
import { type StoreView, serveStoreWatch } from "../src/host/store-watch.ts";
import { onLines } from "../src/protocol/lines.ts";
import { statePaths } from "../src/protocol/paths.ts";
import {
	type HeldAction,
	Message,
	Part,
	Person,
	ProjectEvent,
	ProjectState,
	Rule,
	Term,
	Thread,
} from "../src/protocol/project.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { AGENT_HANDLE } from "../src/protocol/target.ts";
import { cli, models, root, setUp, tearDown, until } from "./helpers.ts";

/** One line of a project watch: the reply, or an event. */
const WatchLine = Type.Union([
	Type.Object({ ok: Type.Literal(true), value: ProjectState }),
	Type.Object({ event: ProjectEvent }),
]);

const NONE: ProjectEvent["removed"] = { persons: [], rules: [], terms: [], threads: [], parts: [], held: [] };

/** An event with the objects of `changes`, no other object, and no removed ID. */
function event(changes: Partial<ProjectEvent>): ProjectEvent {
	return { persons: [], rules: [], terms: [], threads: [], parts: [], held: [], removed: NONE, ...changes };
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

/**
 * A `watch-project` request of `project` on a socket of its own: its socket, the state of the reply, and the events
 * that came so far.
 */
async function openProjectWatch(
	project: string,
): Promise<{ socket: Socket; state: ProjectState; events: ProjectEvent[] }> {
	const socket = createConnection(statePaths(project).socket);
	await once(socket, "connect");
	const replies: ProjectState[] = [];
	const events: ProjectEvent[] = [];

	onLines(socket, (line) => {
		const parsed: unknown = JSON.parse(line);

		if (!Value.Check(WatchLine, parsed)) throw new Error(`not a line of a project watch: ${line.slice(0, 200)}`);

		if ("ok" in parsed) replies.push(parsed.value);
		else events.push(parsed.event);
	});

	socket.write(`${JSON.stringify({ type: "watch-project" })}\n`);
	await until(() => replies.length > 0);
	const [state] = replies;

	if (state === undefined) throw new Error("no reply");

	return { socket, state, events };
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
		let watch: Awaited<ReturnType<typeof openProjectWatch>> | undefined;

		try {
			watch = await openProjectWatch(project);
			const { events } = watch;
			expect(watch.state).toEqual({ persons: [], rules: [], terms: [], threads: [], parts: [], held: [] });

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

			const part = Value.Parse(
				Part,
				await send(
					{ type: "part", action: "add", caller: "cli", kind: "table", path: "Scope.md", rules: [rule.id], terms: [] },
					project,
				),
			);

			expect(await next()).toEqual(event({ parts: [part] }));

			const decided = Value.Parse(
				Rule,
				await send(
					{
						type: "rule",
						action: "set",
						caller: "cli",
						id: rule.id,
						status: "decided",
						saidBy: sam.id,
						source: asked.id,
					},
					project,
				),
			);

			// One commit changes the rule and makes its part stale: one event has both.
			expect(await next()).toEqual(event({ rules: [decided], parts: [{ ...part, stale: true }] }));

			const term = Value.Parse(
				Term,
				await send(
					{
						type: "term",
						action: "set",
						caller: "cli",
						name: "sale type",
						meaning: "The code of a sale.",
						saidBy: sam.id,
						source: asked.id,
					},
					project,
				),
			);

			expect(await next()).toEqual(event({ terms: [term] }));

			const glossary = Value.Parse(
				Part,
				await send(
					{ type: "part", action: "add", caller: "cli", kind: "table", path: "Terms.md", rules: [], terms: [term.id] },
					project,
				),
			);

			expect(await next()).toEqual(event({ parts: [glossary] }));

			const changed = Value.Parse(
				Term,
				await send(
					{
						type: "term",
						action: "set",
						caller: "cli",
						id: term.id,
						meaning: "The code of a sale, such as 45.",
						saidBy: "user",
						source: draft.id,
					},
					project,
				),
			);

			// One commit changes the term and makes its part stale: one event has both.
			expect(await next()).toEqual(event({ terms: [changed], parts: [{ ...glossary, stale: true }] }));

			// A commit that changes no object of the project sends no event.
			await send(
				{ type: "todo", caller: "cli", action: "add", handle: AGENT_HANDLE, text: "Check the scope" },
				project,
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(events).toHaveLength(11);

			const again = await openProjectWatch(project);
			again.socket.destroy();

			expect(again.state).toEqual({
				persons: [sam],
				rules: [decided],
				terms: [changed],
				threads: [{ ...thread, last: draft.at, waits: [sent] }],
				parts: [
					{ ...part, stale: true },
					{ ...glossary, stale: true },
				],
				held: [],
			});
		} finally {
			watch?.socket.destroy();
			await host.close();
		}
	});

	it("sends every object once to a watch that fell behind", async () => {
		const project = "slow-project";
		const host = await projectHost(project);
		let watch: Awaited<ReturnType<typeof openProjectWatch>> | undefined;

		try {
			const sam = Value.Parse(Person, await send({ type: "person", action: "add", name: "Sam" }, project));

			const thread = Value.Parse(
				Thread,
				await send({ type: "thread", action: "add", topic: "Large", persons: [sam.id] }, project),
			);

			watch = await openProjectWatch(project);
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
			const all = await openProjectWatch(project);
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
		const watch = await openProjectWatch(project);

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
			terms: [],
			threads: [{ ...thread, waits: [draft] }],
			parts: [],
			held: [push, merge],
		};

		const after: ProjectState = {
			persons: [sam],
			rules: [],
			terms: [],
			threads: [{ ...thread, waits: [] }],
			parts: [],
			held: [approved],
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
});
