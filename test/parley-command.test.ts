import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import type { Replies, Request } from "../src/protocol/requests.ts";
import { cli, setUp, startHost, tearDown } from "./helpers.ts";

let host: Host | undefined;

/** Sends `line` to the host through the socket. */
async function send<T extends Request["type"]>(line: Extract<Request, { type: T }>): Promise<Replies[T]> {
	const reply = await request(line, { start: false });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

const OPTIONS = [
	{ key: "a", label: "In the store", gains: ["One writer"], costs: ["A protocol bump"] },
	{ key: "b", label: "In files" },
];

/** Writes the parley `slug` with one call, its evidence, its design sense and a read-back, as the caller `pi-1`. */
async function framed(slug: string): Promise<void> {
	await send({
		type: "ask",
		action: "round",
		caller: "pi-1",
		parley: {
			slug,
			title: "Where asks live",
			goal: "Pick the place.",
			evidence: ["The store has one writer", "Files race"],
			design_sense: "One writer.",
		},
		asks: [
			{ title: "Where", kind: "your call", tension: "Speed or safety", options: OPTIONS, plan: "a", view: "The view" },
			{ title: "These are the terms" },
		],
	});
}

/** Answers the call of the parley `slug` in the user's own words, then `ok` to its read-back: the parley is a contract. */
async function contract(slug: string): Promise<void> {
	await framed(slug);

	const read = await send({ type: "parley", action: "read", slug });
	const ids = "asks" in read ? read.asks.map((ask) => ask.id) : [];
	const [call, readBack] = ids;

	if (call === undefined || readBack === undefined) throw new Error("no asks");
	await send({
		type: "ask",
		action: "answer",
		caller: "user",
		answers: [{ id: call, answer: "own", label: "In the store, with a view", words: ["Keep it.", "And the view."] }],
	});
	await send({ type: "ask", action: "answer", caller: "user", answers: [{ id: readBack, answer: "ok" }] });
}

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("harness parley show", { timeout: 30_000 }, () => {
	it("prints a contract with the answers and the words of the user, without the read-back", async () => {
		await contract("made");

		expect(await cli(["parley", "show", "made"])).toEqual({
			code: 0,
			stdout:
				"# Where asks live\n\nPick the place.\n\n## 1. Where\n\nAnswer: In the store, with a view\n\nKeep it.\n\n" +
				"And the view.\n\n## Design sense\n\nOne writer.\n\n## Evidence\n\n- The store has one writer\n- Files race\n",
			stderr: "",
		});
	});

	it("prints the plan of an open ask", async () => {
		await framed("waiting");

		expect(await cli(["parley", "show", "waiting"])).toEqual({
			code: 0,
			stdout:
				"# Where asks live\n\nPick the place.\n\n## 1. Where\n\nOpen, plan a: In the store\n\n" +
				"## Design sense\n\nOne writer.\n\n## Evidence\n\n- The store has one writer\n- Files race\n",
			stderr: "",
		});
	});

	it("puts the status of a done or dropped parley in the title", async () => {
		for (const status of ["done", "dropped"] as const) {
			const slug = `ended-${status}`;
			await contract(slug);
			await send({ type: "parley", action: "end", caller: "pi-1", slug, status });

			const result = await cli(["parley", "show", slug]);
			expect(result).toMatchObject({ code: 0, stderr: "" });
			expect(result.stdout.split("\n")[0]).toBe(`# Where asks live (${status})`);
		}
	});

	it("fails with one line for an unknown slug", async () => {
		expect(await cli(["parley", "show", "nope"])).toEqual({ code: 1, stdout: "", stderr: "Unknown parley: nope\n" });
	});

	it("prints the usage for other arguments", async () => {
		for (const args of [["list"], ["show"], ["show", "made", "more"], []]) {
			const result = await cli(["parley", ...args]);
			expect(result).toMatchObject({ code: 1, stdout: "" });
			expect(result.stderr).toContain("  harness parley show <slug>\n");
		}
	});
});
