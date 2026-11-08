import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { serveRlm } from "../src/host/rlm.ts";
import {
	HARNESS_RLM_SOCKET,
	HARNESS_RLM_TOKEN,
	KERNEL_STARTING,
	type KernelStarting,
	STARTUP_CODE,
} from "../src/rlm/kernel.ts";
import { type KernelScope, KernelServers } from "../src/rlm/server.ts";
import type { Send } from "../src/tool.ts";
import { rawReply, until } from "./helpers.ts";

const scope = async (): Promise<KernelScope> => ({
	caller: "kernel",
	provider: "faux",
	model: "faux-1",
	thinking: "off",
	cwd: "/tmp",
});

/** A kernel start without a conversation, as in Pi. */
const kernelStart = (): Pick<KernelStarting, "env" | "startupCode"> => ({ env: {}, startupCode: [] });

/** Serves a kernel start of the key `kernel` with `servers`, and gives the environment of the kernel. */
async function served(servers: KernelServers): Promise<Record<string, string>> {
	const starting = kernelStart();
	await servers.serve(starting, "kernel", scope);

	return starting.env;
}

describe("kernel servers", () => {
	it("refuses a wrong token, stops a request whose connection closes, and removes the socket at close", async () => {
		const signals: AbortSignal[] = [];

		// Each request waits until its signal aborts.
		const send: Send = (_request, signal) => {
			signals.push(signal);

			return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		};

		const servers = new KernelServers(send);
		const starting = kernelStart();
		await servers.serve(starting, "kernel", scope);
		const { env } = starting;
		expect(starting.startupCode).toEqual(STARTUP_CODE);
		const socket = env[HARNESS_RLM_SOCKET] ?? "";
		const wrong = JSON.stringify({ token: "wrong", action: "list", args: {} });
		expect(JSON.parse(await rawReply(socket, wrong))).toEqual({ ok: false, error: "Invalid rlm token" });
		expect(signals).toEqual([]);

		const waiting = createConnection(socket);
		waiting.write(`${JSON.stringify({ token: env[HARNESS_RLM_TOKEN], action: "wait", args: { handle: "abc123" } })}\n`);
		await until(() => signals.length === 1);
		expect(signals[0]?.aborted).toBe(false);
		waiting.destroy();
		await until(() => signals[0]?.aborted === true);

		await servers.close();
		expect(existsSync(dirname(socket))).toBe(false);
		const late = kernelStart();
		await expect(servers.serve(late, "kernel", scope)).rejects.toThrow("The host is closing");
		expect(late).toEqual(kernelStart());
	});

	it("refuses the arguments that the tool refuses, with the error of their field", async () => {
		const sent: string[] = [];

		const send: Send = async (request) => {
			sent.push(request.type);
			throw new Error("sent");
		};

		const servers = new KernelServers(send);
		const env = await served(servers);

		const reply = async (action: string, args: Record<string, string | number>) => {
			const line = JSON.stringify({ token: env[HARNESS_RLM_TOKEN], action, args });

			return JSON.parse(await rawReply(env[HARNESS_RLM_SOCKET] ?? "", line));
		};

		try {
			expect(await reply("wait", { handle: "abc123", timeout: 0 })).toEqual({
				ok: false,
				error: "Invalid rlm request: /timeout must be >= 1",
			});
			expect(await reply("rename", { handle: "abc123", name: 3 })).toEqual({
				ok: false,
				error: "Invalid rlm request: /name must be string",
			});
			expect(await reply("send", { handle: "abc123" })).toEqual({ ok: false, error: "send requires message" });
			expect(sent).toEqual([]);
		} finally {
			await servers.close();
		}
	});

	it("refuses a line longer than 1 MiB plus 64 KiB, and serves a line of that size", async () => {
		const sent: string[] = [];

		const send: Send = async (request) => {
			sent.push(request.type);
			throw new Error("sent");
		};

		const servers = new KernelServers(send);
		const env = await served(servers);
		const limit = 1024 * 1024 + 64 * 1024;
		const line = JSON.stringify({ token: env[HARNESS_RLM_TOKEN], action: "list", args: {} });

		// A valid request, with spaces after it up to `bytes` bytes.
		const reply = async (bytes: number) =>
			JSON.parse(await rawReply(env[HARNESS_RLM_SOCKET] ?? "", line.padEnd(bytes, " ")));

		try {
			expect(await reply(limit + 1)).toEqual({
				ok: false,
				error: "Invalid rlm request: the line is longer than 1 MiB plus 64 KiB",
			});
			expect(sent).toEqual([]);
			expect(await reply(limit)).toEqual({ ok: false, error: "sent" });
			expect(sent).toEqual(["list"]);
		} finally {
			await servers.close();
		}
	});

	it("fails a kernel start that comes after the close", async () => {
		const send: Send = async () => {
			throw new Error("sent");
		};

		const events = createEventBus();
		const warnings: unknown[] = [];
		const store = { snapshot: async () => undefined, conversation: async () => undefined };
		const rlm = serveRlm(events, { store }, send, (cause) => warnings.push(cause));
		await rlm.close();

		const waits: Promise<void>[] = [];
		const env = {};
		const startupCode: string[] = [];
		const waitFor = (promise: Promise<void>) => void waits.push(promise);
		events.emit(KERNEL_STARTING, { conversationId: 7, env, startupCode, waitFor });

		expect(waits).toHaveLength(1);
		await expect(waits[0]).rejects.toThrow("The host is closing");
		expect(env).toEqual({});
		expect(startupCode).toEqual([]);
		expect(warnings).toEqual([]);
	});
});
