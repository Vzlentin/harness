import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { AnswerListener } from "../src/client/answers.ts";
import type { Host } from "../src/host/run.ts";
import type { Delivery } from "../src/protocol/requests.ts";
import {
	answerOf,
	calls,
	cellResults,
	openWatch,
	scripts,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	textOf,
	until,
} from "./helpers.ts";

/** A first message whose answer, `Answer to <prompt>`, is more than 256 KiB in UTF-8. */
const LONG = `Task:\nx${"\u20ac".repeat(90_000)}`;

/** 17 bytes of `Answer to Task:\nx`, then whole characters of 3 bytes up to 256 KiB, then the cut line. */
const CUT = `Answer to Task:\nx${"\u20ac".repeat(87_375)}\n[The answer was cut at 256 KiB]`;

/** A first message whose model spawns a child with the `subagent` tool, and ends its turn without a wait. */
const PARENT = "Task:\nSpawn a long answer";

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("answer cut", { timeout: 30_000 }, () => {
	it("cuts the answer that wait gives for a child of any kind, on a character boundary", async () => {
		const child = await spawnAs("cut-wait", LONG, { notify: false });

		expect(await answerOf(child.handle)).toBe(CUT);
	});

	it("cuts the answer that a push gives to a conversation of the host", async () => {
		scripts.set(PARENT, [
			{ name: "subagent", arguments: { action: "spawn", name: "nested", prompts: [LONG.slice(6)] } },
		]);
		await spawnAs("cut-host", PARENT, { notify: false });
		await until(() => (cellResults.get(PARENT) ?? []).length === 1);
		const handle = /^Spawned nested \(([a-z0-9]+)\)$/m.exec(cellResults.get(PARENT)?.[0] ?? "")?.[1];
		const header = `subagent nested (${handle}) finished`;
		await until(() => calls.some((call) => call.prompt.startsWith(header)));

		expect(calls.find((call) => call.prompt.startsWith(header))?.prompt).toBe(`${header}\n\n${CUT}`);
	});

	it("cuts the answer that a push gives to an answers request", async () => {
		const deliveries: Delivery[] = [];

		const listener = new AnswerListener("cut-answers", (delivery) => deliveries.push(delivery), {
			start: false,
			onError: () => {},
		});

		try {
			const child = await spawnAs("cut-answers", LONG, { notify: true });
			await until(() => deliveries.length === 1);

			expect(deliveries[0]).toMatchObject({ source: "child", handle: child.handle, text: CUT, failed: false });
		} finally {
			listener.close();
		}
	});

	it("keeps the whole answer in the conversation of the child", async () => {
		const child = await spawnAs("cut-watch", LONG, { notify: false });
		await answerOf(child.handle);
		const watched = await openWatch({ kind: "child", handle: child.handle });
		watched.client.close();

		const assistant = watched.view.entries.flatMap((entry) => {
			const message = entry.model?.[0];

			return message?.role === "assistant" ? [textOf(message)] : [];
		});

		expect(assistant).toEqual([`Answer to ${LONG}`]);
	});
});
