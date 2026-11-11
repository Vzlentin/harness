import { once } from "node:events";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Client, request } from "../src/client/client.ts";
import { todosOf } from "../src/client/view-state.ts";
import type { Host } from "../src/host/run.ts";
import { statePaths } from "../src/protocol/paths.ts";
import type { WatchLine } from "../src/protocol/requests.ts";
import { type Target, targetRef } from "../src/protocol/target.ts";
import { TODO_LIST_KIND, type TodoState } from "../src/protocol/todo.ts";
import { applyChange } from "../src/protocol/view-change.ts";
import { cli, handleOf, listsOf, openWatch, setUp, startHost, tearDown, until } from "./helpers.ts";

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

/** Adds the note `text` to the conversation of `handle`. */
async function note(handle: string, requestId: string, text: string): Promise<void> {
	await request({ type: "note", requestId, handle, text }, { start: false });
}

/** Adds the todo `text` to the list of `target`. */
async function addTo(target: Target, text: string): Promise<void> {
	await request({ type: "todo", caller: "cli", action: "add", ...targetRef(target), text }, { start: false });
}

/** Sets the state of the todo `id` in the list of `target`. */
async function setIn(target: Target, id: number, state: TodoState): Promise<void> {
	await request({ type: "todo", caller: "cli", action: "set", ...targetRef(target), id, state }, { start: false });
}

/**
 * Checks that each watch of `target` gives the list of todos of its conversation in its reply and one event for each
 * change of the list, the first `add` included, and no event for a change of the list of `other`. The conversation of
 * `target` has no list at the start.
 */
async function expectListEvents(target: Target, other: Target): Promise<void> {
	const first = { id: 1, text: "First step", state: "open" };
	const second = { id: 2, text: "Second step", state: "open" };
	const lists = [{ todos: [first] }, { todos: [first, second] }, { todos: [{ ...first, state: "doing" }, second] }];
	const before = await openWatch(target);
	let after: Awaited<ReturnType<typeof openWatch>> | undefined;

	try {
		expect(before.view.docs[TODO_LIST_KIND]).toBeUndefined();
		expect(todosOf(before.view)).toEqual({ todos: [] });

		await addTo(target, "First step");
		await addTo(other, "Not this list");
		await until(() => listsOf(before.lines).length >= 1);
		expect(listsOf(before.lines)).toEqual(lists.slice(0, 1));

		after = await openWatch(target);
		expect(after.view.docs[TODO_LIST_KIND]).toEqual(lists[0]);

		await addTo(target, "Second step");
		await setIn(target, 1, "doing");
		const { lines } = after;
		await until(() => listsOf(lines).length >= 2 && listsOf(before.lines).length >= 3);
		expect(listsOf(lines)).toEqual(lists.slice(1));
		expect(listsOf(before.lines)).toEqual(lists);

		const view = before.lines.reduce(
			(current, line) => (line.stopped ? current : applyChange(current, line.change)),
			before.view,
		);

		expect(todosOf(view)).toEqual(lists[2]);
	} finally {
		before.client.close();
		after?.client.close();
	}
}

describe("watch", { timeout: 30_000 }, () => {
	it("sends the stopped line after the lines of the commits before the stop, to a slow client", async () => {
		const handle = handleOf(await cli(["spawn", "--name", "watched", "--prompt", "Watch the stop"]));
		await cli(["wait", handle]);
		const socket = createConnection(statePaths("main").socket);
		await once(socket, "connect");
		const client = new Client(socket);

		try {
			const watched = await client.watch({ kind: "child", handle });
			const events: WatchLine[] = [];

			const ended = (async () => {
				for await (const line of watched.lines) events.push(line);
			})();

			// The client reads nothing while the host waits for the socket to drain after the line of a large note.
			socket.pause();
			await note(handle, "large", "x".repeat(1_000_000));
			await note(handle, "last", "Last note before the stop");
			expect((await cli(["stop", handle])).code).toBe(0);
			// The `ChildRecords` watch gets the stop after the reply.
			await new Promise((resolve) => setTimeout(resolve, 300));
			socket.resume();
			await ended;

			expect(events.at(-1)).toEqual({ stopped: true });
			const changes = events.flatMap((line) => (line.stopped ? [] : [JSON.stringify(line.change)]));
			expect(changes.some((change) => change.includes("Last note before the stop"))).toBe(true);
		} finally {
			client.close();
		}
	});

	it("gives the list of todos of a child, and an event for each change of it", async () => {
		const handle = handleOf(await cli(["spawn", "--name", "listed", "--prompt", "Watch the list"]));
		const other = handleOf(await cli(["spawn", "--name", "other", "--prompt", "Keep another list"]));
		await cli(["wait", handle]);

		await expectListEvents({ kind: "child", handle }, { kind: "child", handle: other });
	});

	it("gives the list of todos of the project agent, and an event for each change of it", async () => {
		const other = handleOf(await cli(["spawn", "--name", "apart", "--prompt", "Keep a list apart"]));

		await expectListEvents({ kind: "agent" }, { kind: "child", handle: other });
	});

	it("sends the list of todos in the whole view before the stopped line", async () => {
		const handle = handleOf(await cli(["spawn", "--name", "stopped", "--prompt", "Stop with a list"]));
		await cli(["wait", handle]);
		await addTo({ kind: "child", handle }, "Before the stop");
		const watched = await openWatch({ kind: "child", handle });

		try {
			expect((await cli(["stop", handle])).code).toBe(0);
			await watched.ended;

			expect(watched.lines.at(-1)).toEqual({ stopped: true });
			expect(watched.lines.at(-2)).toMatchObject({
				change: {
					view: { docs: { [TODO_LIST_KIND]: { todos: [{ id: 1, text: "Before the stop", state: "open" }] } } },
				},
			});
		} finally {
			watched.client.close();
		}
	});
});
