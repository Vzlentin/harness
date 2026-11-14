import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import {
	CELL_START,
	HARNESS_TOOLS_SOCKET,
	HARNESS_TOOLS_TOKEN,
	KERNEL_STARTING,
	type KernelStarting,
	STARTUP_CODE,
} from "../src/bridge/kernel.ts";
import { type Cell, KernelServers } from "../src/bridge/server.ts";
import { serveBridge } from "../src/host/bridge.ts";
import { rawReply, until } from "./helpers.ts";

/** A request line of the tests, which may break the shape of a request. */
type Line = {
	readonly token?: string;
	readonly list?: boolean;
	readonly name?: string | number;
	readonly args?: JsonObject;
};

/** A kernel start without a conversation, as in Pi. */
const kernelStart = (): Pick<KernelStarting, "env" | "startupCode"> => ({ env: {}, startupCode: [] });

/** A cell with `ipython` and `todo`, whose calls wait until their signal aborts. It keeps their names and signals. */
function hangingCell(): Cell & { readonly calls: { readonly name: string; readonly signal: AbortSignal }[] } {
	const calls: { readonly name: string; readonly signal: AbortSignal }[] = [];

	return {
		calls,
		call: ({ name }, _args, signal) => {
			calls.push({ name, signal });

			return new Promise<never>(() => {});
		},
		tools: async () => [
			{ name: "ipython", description: "Runs Python", parameters: { type: "object" }, structured: false },
			{ name: "todo", description: "Keeps todos", parameters: { type: "object" }, structured: false },
		],
	};
}

/** Serves a kernel start of the key `kernel` with `servers`, and gives the socket and a reply for a request line. */
async function served(servers: KernelServers) {
	const starting = kernelStart();
	await servers.serve(starting, "kernel");
	const socket = starting.env[HARNESS_TOOLS_SOCKET] ?? "";
	const token = starting.env[HARNESS_TOOLS_TOKEN];

	const reply = async (line: Line, padTo = 0) =>
		JSON.parse(await rawReply(socket, JSON.stringify({ token, ...line }).padEnd(padTo, " ")));

	return { starting, socket, reply };
}

describe("kernel servers", () => {
	it("runs a request with the open cell of the kernel, and refuses one without it", async () => {
		const servers = new KernelServers();
		const { starting, socket, reply } = await served(servers);
		const cell = hangingCell();

		try {
			expect(starting.startupCode).toEqual(STARTUP_CODE);
			expect(socket).toMatch(/^\/tmp\/harness-tools-[^/]+\/kernel\.sock$/);
			expect(await reply({ name: "todo", args: {} })).toEqual({
				ok: false,
				error: "No cell of this kernel runs: tools runs a tool only while a cell runs",
			});

			servers.open("kernel", "cell-1", cell);
			expect(await reply({ token: "wrong", name: "todo", args: {} })).toEqual({
				ok: false,
				error: "Invalid tools token",
			});
			expect(await reply({ name: 3, args: {} })).toEqual({
				ok: false,
				error: "Invalid tools request: /name must be string",
			});
			expect(await reply({ list: true, args: {} })).toEqual({
				ok: false,
				error: "Invalid tools request: /args schema is false",
			});
			expect(await reply({ list: true })).toEqual({
				ok: true,
				value: [{ name: "todo", description: "Keeps todos", parameters: { type: "object" } }],
			});
			expect(await reply({ name: "ipython", args: { code: "1" } })).toEqual({
				ok: false,
				error: "A cell cannot run ipython: its kernel is busy with the cell",
			});
			expect(cell.calls).toEqual([]);

			// The end of the cell stops its call, and a call after it finds no cell.
			const waiting = reply({ name: "todo", args: { action: "list" } });
			await until(() => cell.calls.length === 1);
			expect(cell.calls[0]?.signal.aborted).toBe(false);
			servers.end("kernel", "cell-1");
			expect(await waiting).toEqual({ ok: false, error: "The cell ended: tools runs a tool only while a cell runs" });
			expect(cell.calls[0]?.signal.aborted).toBe(true);
			expect((await reply({ name: "todo", args: {} })).error).toMatch(/^No cell of this kernel runs/);
		} finally {
			await servers.close();
		}
	});

	it("fails a call of a tool with an output schema that gives no structured output", async () => {
		const servers = new KernelServers();
		const { reply } = await served(servers);

		servers.open("kernel", "cell-1", {
			call: async () => ({ isError: false, text: "" }),
			tools: async () => [
				{ name: "todo", description: "Keeps todos", parameters: { type: "object" }, structured: true },
			],
		});

		try {
			expect(await reply({ name: "todo", args: {} })).toEqual({
				ok: false,
				error: "Tool todo gave no structured output",
			});
		} finally {
			await servers.close();
		}
	});

	it("refuses a line longer than 16 MiB, and serves a line of that size", async () => {
		const servers = new KernelServers();
		const { reply } = await served(servers);
		const limit = 16 * 1024 * 1024;

		try {
			expect(await reply({ list: true }, limit + 1)).toEqual({
				ok: false,
				error: "Invalid tools request: the line is longer than 16 MiB",
			});
			expect(await reply({ list: true }, limit)).toEqual({
				ok: false,
				error: "No cell of this kernel runs: tools runs a tool only while a cell runs",
			});
		} finally {
			await servers.close();
		}
	});

	it("stops a call that hangs when it closes, removes the socket, and refuses a later kernel start", async () => {
		const servers = new KernelServers();
		const { socket, reply } = await served(servers);
		const cell = hangingCell();
		servers.open("kernel", "cell-1", cell);
		const waiting = reply({ name: "todo", args: {} });
		await until(() => cell.calls.length === 1);

		await servers.close();
		expect(await waiting).toEqual({ ok: false, error: "The host is closing" });
		expect(existsSync(dirname(socket))).toBe(false);
		const late = kernelStart();
		await expect(servers.serve(late, "kernel")).rejects.toThrow("The host is closing");
		expect(late).toEqual(kernelStart());
	});

	it("fails a kernel start of the host that comes after the close, and warns of an invalid cell start", async () => {
		const events = createEventBus();
		const warnings: unknown[] = [];
		const bridge = serveBridge(events, (cause) => warnings.push(cause));

		events.emit(CELL_START.channel, { conversationId: 7 });
		expect(warnings).toEqual([new Error(CELL_START.invalid)]);
		await bridge.close();

		const waits: Promise<void>[] = [];
		const env = {};
		const startupCode: string[] = [];
		const waitFor = (promise: Promise<void>) => void waits.push(promise);
		events.emit(KERNEL_STARTING.channel, { conversationId: 7, env, startupCode, waitFor });

		expect(waits).toHaveLength(1);
		await expect(waits[0]).rejects.toThrow("The host is closing");
		expect(env).toEqual({});
		expect(startupCode).toEqual([]);
		expect(warnings).toHaveLength(1);
	});
});
