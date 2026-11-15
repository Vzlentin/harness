import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Client, connect, HostUnreachableError } from "../src/client/client.ts";
import { onLines } from "../src/protocol/lines.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { PROTOCOL_VERSION, versionMismatch } from "../src/protocol/requests.ts";

let server: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
	server?.close();
	server = undefined;

	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

/** A client of a fake host that answers its first request line with `first`, and each later line with a valid reply. */
async function clientOf(first: string): Promise<Client> {
	// macOS limits a Unix socket path to 104 bytes, so the socket stays under /tmp.
	dir = await mkdtemp("/tmp/harness-client-");
	const path = join(dir, "host.sock");
	let lines = 0;

	server = createServer((socket: Socket) => {
		onLines(socket, () => {
			lines += 1;
			socket.write(`${lines === 1 ? first : JSON.stringify({ ok: true, value: lines })}\n`);
		});
	});
	await new Promise<void>((resolve) => server?.listen(path, resolve));
	const socket = createConnection(path);
	await new Promise((resolve) => socket.once("connect", resolve));

	return new Client(socket);
}

describe("client", () => {
	for (const [what, line] of [
		["a reply that is not valid", JSON.stringify({ ok: "yes" })],
		["a line that is not JSON", "not json"],
	] as const) {
		it(`ends the connection and rejects every waiting request after ${what}`, async () => {
			const client = await clientOf(line);

			const replies = [
				client.request({ type: "list", caller: "a" }),
				client.request({ type: "list", caller: "b" }),
			].map((reply) =>
				reply.then(
					(value) => ({ value }),
					(error: Error) => ({ error: String(error) }),
				),
			);

			const error = `Error: The harness host sent an invalid reply: ${line}`;
			expect(await Promise.all(replies)).toEqual([{ error }, { error }]);
			expect(client.ended).toBe(true);
			const closed = client.request({ type: "list", caller: "c" });
			await expect(closed).rejects.toThrow("The harness host closed the connection");
			await expect(closed).rejects.toBeInstanceOf(HostUnreachableError);
		});
	}

	it("refuses a host of another protocol version, and sends a hello without external", async () => {
		const state = process.env.XDG_STATE_HOME;
		// macOS limits a Unix socket path to 104 bytes, so the state folder stays under /tmp.
		dir = await mkdtemp("/tmp/harness-client-");
		process.env.XDG_STATE_HOME = dir;

		try {
			const { socket } = statePaths("main");
			await mkdir(dirname(socket), { recursive: true });
			const hellos: unknown[] = [];
			server = createServer((connection: Socket) => {
				onLines(connection, (line) => {
					hellos.push(JSON.parse(line));
					connection.write(`${JSON.stringify({ ok: true, value: { version: PROTOCOL_VERSION + 1, pid: 7 } })}\n`);
				});
			});
			await new Promise<void>((resolve) => server?.listen(socket, resolve));

			const connecting = connect({ start: false, project: "main" });
			await expect(connecting).rejects.toThrow(versionMismatch(PROTOCOL_VERSION, PROTOCOL_VERSION + 1, 7));
			await expect(connecting).rejects.toBeInstanceOf(HostUnreachableError);
			expect(hellos).toEqual([{ type: "hello", version: PROTOCOL_VERSION }]);
		} finally {
			if (state === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = state;
		}
	});
});
