import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import { todosOf } from "../src/client/view-state.ts";
import type { Host } from "../src/host/run.ts";
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

		const view = before.lines.reduce((current, line) => applyChange(current, line.change), before.view);

		expect(todosOf(view)).toEqual(lists[2]);
	} finally {
		before.client.close();
		after?.client.close();
	}
}

describe("watch", { timeout: 30_000 }, () => {
	it("gives a line with the state ended after a stop, keeps the watch open, and gives the resume of a send", async () => {
		const handle = handleOf(await cli(["spawn", "--name", "watched", "--prompt", "Watch the stop"]));
		await cli(["wait", handle]);
		const watched = await openWatch({ kind: "child", handle });
		let closed = false;
		void watched.ended.then(() => (closed = true));

		try {
			expect((await cli(["stop", handle])).code).toBe(0);
			await until(() => watched.lines.some((line) => line.child.state === "ended"));

			expect((await cli(["send", handle, "Resume the watched"])).stdout).toBe(`Prompted watched (${handle})\n`);
			const ended = () => watched.lines.findIndex((line) => line.child.state === "ended");
			await until(() => watched.lines.slice(ended() + 1).some((line) => line.child.state === "idle"));

			const changes = watched.lines.map((line) => JSON.stringify(line.change));
			expect(changes.some((change) => change.includes("Answer to Resume the watched"))).toBe(true);
			expect(closed).toBe(false);
		} finally {
			watched.client.close();
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
});
