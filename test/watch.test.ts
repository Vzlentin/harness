import { once } from "node:events";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, request } from "../src/client.ts";
import type { Host } from "../src/host.ts";
import { statePaths, type WatchLine } from "../src/protocol.ts";
import { cli, handleOf, setUp, startHost, tearDown } from "./helpers.ts";

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

describe("watch", { timeout: 30_000 }, () => {
	it("sends the stopped line after the lines of the commits before the stop, to a slow client", async () => {
		const handle = handleOf(await cli(["spawn", "--name", "watched", "--prompt", "Watch the stop"]));
		await cli(["wait", handle]);
		const socket = createConnection(statePaths("main").socket);
		await once(socket, "connect");
		const client = new Client(socket);

		try {
			const watched = await client.watch(handle);
			const events: WatchLine[] = [];

			const ended = (async () => {
				for await (const line of watched.lines) events.push(line);
			})();

			// The client reads nothing while the host waits for the socket to drain after the line of a large note.
			socket.pause();
			await note(handle, "large", "x".repeat(1_000_000));
			await note(handle, "last", "Last note before the stop");
			expect((await cli(["stop", handle])).code).toBe(0);
			// The `Children` watch gets the stop after the reply.
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
});
