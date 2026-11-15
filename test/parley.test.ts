import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import {
	Ask,
	type AskEvent,
	type AskState,
	AskList,
	askTransition,
	AskWrite,
	Parley,
	ParleyAsks,
	ParleyList,
} from "../src/protocol/project.ts";
import type { Request } from "../src/protocol/requests.ts";
import { answer, framed, OPTIONS, round, send, setUp, startHost, tearDown } from "./helpers.ts";

let host: Host | undefined;

async function readParley(slug: string): Promise<ParleyAsks> {
	return Value.Parse(ParleyAsks, await send({ type: "parley", action: "read", slug }));
}

/** Everything that the store has of the asks and the parleys. */
async function stored(): Promise<{ parleys: ParleyList; open: AskList }> {
	return {
		parleys: Value.Parse(ParleyList, await send({ type: "parley", action: "list" })),
		open: Value.Parse(AskList, await send({ type: "ask", action: "list" })),
	};
}

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("asks and parleys", { timeout: 30_000 }, () => {
	it("keeps the asks and the parleys of the rounds, numbered in their parley, also after a host restart", async () => {
		const first = await round(
			"pi-1",
			{ slug: "store-place", title: "Where asks live", goal: "Pick the place.", evidence: ["The skill today"] },
			[
				{ title: "Where", kind: "your call", tension: "One writer or many", options: OPTIONS, plan: "a" },
				{ title: "Which view", view: "A `table` with **bold**" },
			],
		);

		expect(first).toMatchObject({
			parleys: [
				{
					parley: { id: 1, slug: "store-place", status: "open", evidence: ["The skill today"], by: "pi-1" },
					asks: [
						{ id: 1, state: "open", parley: { id: 1, n: 1 }, asker: "pi-1", options: OPTIONS, plan: "a" },
						{ id: 2, state: "open", parley: { id: 1, n: 2 }, asker: "pi-1", view: "A `table` with **bold**" },
					],
				},
			],
			asks: [],
		});

		const alone = await round("khan", undefined, [{ title: "Push now?" }]);
		expect(alone).toMatchObject({ parleys: [], asks: [{ id: 3, state: "open", asker: "khan" }] });
		expect(alone.asks[0]?.parley).toBeUndefined();

		const second = await round("pi-2", { slug: "store-place", goal: "Pick the one place." }, [{ title: "Who asks" }]);
		expect(second.parleys).toMatchObject([
			{
				parley: { id: 1, title: "Where asks live", goal: "Pick the one place." },
				asks: [{ id: 1 }, { id: 2 }, { id: 4, parley: { id: 1, n: 3 }, asker: "pi-2" }],
			},
		]);
		expect(second.asks).toEqual([]);

		// An answer names its ask by ID, or by its number in its parley.
		const answered = await answer([
			{ slug: "store-place", n: 1, answer: "own", label: "In the store, with a view", words: ["keep `view` too"] },
			{ id: 3, answer: "own", label: "Not yet" },
		]);

		expect(answered).toMatchObject({
			parleys: [
				{
					parley: { slug: "store-place", status: "open" },
					asks: [{ id: 1, state: "answered", answer: "own", label: "In the store, with a view", by: "user" }, {}, {}],
				},
			],
			asks: [{ id: 3, state: "answered", answer: "own", label: "Not yet" }],
		});

		// A new answer replaces the answer, the label and the words as one unit.
		const replaced = (await answer([{ id: 1, answer: "b" }])).parleys[0]?.asks[0];
		expect(replaced).toEqual({
			...first.parleys[0]?.asks[0],
			state: "answered",
			answer: "b",
			at: replaced?.at,
			by: "user",
		});

		const taken = Value.Parse(
			ParleyAsks,
			await send({ type: "parley", action: "take", caller: "pi-3", slug: "store-place" }),
		);

		expect(taken.asks.map((ask) => [ask.parley?.n, ask.state, ask.asker])).toEqual([
			[1, "answered", "pi-1"],
			[2, "open", "pi-3"],
			[3, "open", "pi-3"],
		]);

		const before = { ...(await stored()), read: await readParley("store-place") };
		expect(before.open.asks.map((ask) => ask.id)).toEqual([2, 4]);
		expect(before.read).toEqual(taken);

		await host?.close();
		host = await startHost();

		expect({ ...(await stored()), read: await readParley("store-place") }).toEqual(before);
	});

	it("makes a contract with the answer ok to the read-back, and not with a correction", async () => {
		const { call, readBack } = await framed("read-back");
		await answer([{ id: call, answer: "a" }]);

		const corrected = await answer([{ id: readBack, answer: "own", label: "Not yet", words: ["Add the gate."] }]);
		expect(corrected.parleys.map(({ parley }) => parley.status)).toEqual(["open"]);
		expect((await readParley("read-back")).parley.status).toBe("open");

		const agreed = await answer([{ id: readBack, answer: "ok" }]);
		expect(agreed.parleys).toMatchObject([
			{
				parley: { slug: "read-back", status: "contract", design_sense: "One writer." },
				asks: [{ id: call }, { id: readBack, state: "answered", answer: "ok" }],
			},
		]);
		expect(agreed.parleys[0]?.asks[1]).not.toHaveProperty("words");
		expect(await readParley("read-back")).toEqual(agreed.parleys[0]);
	});

	it("reads one ask in any state, by its ID or by its number in its parley", async () => {
		const lone = (await round("khan", undefined, [{ title: "Tag it?", view: "The tag `v1`" }])).asks[0]?.id ?? 0;
		await answer([{ id: lone, answer: "own", label: "Yes" }]);
		const { call } = await framed("read-one");
		await answer([{ id: call, answer: "b" }]);

		const byId = Value.Parse(Ask, await send({ type: "ask", action: "read", id: lone }));
		expect(byId).toMatchObject({ id: lone, state: "answered", label: "Yes", view: "The tag `v1`" });
		const byNumber = Value.Parse(Ask, await send({ type: "ask", action: "read", slug: "read-one", n: 1 }));
		expect(byNumber).toMatchObject({ id: call, state: "answered", answer: "b" });
	});

	it("keeps only the known fields of an option and of an answer", async () => {
		const roundLine = {
			type: "ask",
			action: "round",
			caller: "pi-1",
			parley: { slug: "known-fields", title: "Known fields", goal: "Keep the shape." },
			asks: [{ title: "Which", options: [{ key: "a", label: "A", gains: ["G"], extra: "x" }] }],
		};

		const written = JSON.stringify(await send(JSON.parse(JSON.stringify(roundLine))));
		const id = Value.Parse(AskWrite, JSON.parse(written)).parleys[0]?.asks[0]?.id;

		const answerLine = {
			type: "ask",
			action: "answer",
			caller: "user",
			answers: [{ id, answer: "a", words: ["Yes"], leaked: { big: true } }],
		};

		const answered = JSON.stringify(await send(JSON.parse(JSON.stringify(answerLine))));
		const read = JSON.stringify(await send({ type: "parley", action: "read", slug: "known-fields" }));

		for (const reply of [written, answered, read]) {
			expect(reply).toContain('"gains":["G"]');
			expect(reply).not.toContain("extra");
		}

		for (const reply of [answered, read]) {
			expect(reply).toContain('"words":["Yes"]');
			expect(reply).not.toContain("leaked");
		}
	});

	it("makes a contract in the write that answers the last call and the read-back together", async () => {
		const { call, readBack } = await framed("one-write");

		const written = await answer([
			{ id: readBack, answer: "ok" },
			{ id: call, answer: "b" },
		]);

		expect(written.parleys).toMatchObject([{ parley: { slug: "one-write", status: "contract" } }]);
	});

	it("ends a contract as done or dropped, and not an open parley", async () => {
		for (const status of ["done", "dropped"] as const) {
			const slug = `ends-${status}`;
			const { call, readBack } = await framed(slug);
			const end = { type: "parley", action: "end", caller: "pi-1", slug, status } as const;

			await expect(send(end)).rejects.toThrow(`Parley ${slug} is open: only a contract ends`);
			await answer([
				{ id: call, answer: "a" },
				{ id: readBack, answer: "ok" },
			]);

			const ended = Value.Parse(Parley, await send(end));
			expect(ended).toMatchObject({ slug, status, by: "pi-1" });
			expect((await readParley(slug)).parley).toEqual(ended);
			await expect(send(end)).rejects.toThrow(`Parley ${slug} is ${status}: only a contract ends`);
		}
	});

	it("refuses a write that breaks a check with a clear error, and changes nothing", async () => {
		const { call, readBack } = await framed("checked");
		const lone = (await round("khan", undefined, [{ title: "Merge?", options: OPTIONS }])).asks[0]?.id ?? 0;
		const plain = (await round("khan", undefined, [{ title: "Why?" }])).asks[0]?.id ?? 0;
		const dropped = Value.Parse(AskWrite, await send({ type: "ask", action: "drop", caller: "khan", id: plain }));
		expect(dropped).toMatchObject({ parleys: [], asks: [{ id: plain, state: "dropped", by: "khan" }] });
		const sense = await round("pi-1", { slug: "no-sense-yet", title: "T", goal: "G." }, [{ title: "Terms" }]);
		const senseless = sense.parleys[0]?.asks[0]?.id ?? 0;
		const contract = await framed("signed");
		await answer([
			{ id: contract.call, answer: "a" },
			{ id: contract.readBack, answer: "ok" },
		]);

		const before = { ...(await stored()), asks: await everyAsk() };

		const refused: [Request, string][] = [
			[
				{ type: "ask", action: "round", caller: "pi-1", parley: { slug: "fresh", goal: "G." }, asks: [{ title: "T" }] },
				"Parley fresh is new: title is required",
			],
			[
				{ type: "ask", action: "round", caller: "pi-1", parley: { slug: "fresh", title: "T" }, asks: [{ title: "T" }] },
				"Parley fresh is new: goal is required",
			],
			[
				{ type: "ask", action: "round", caller: "pi-1", parley: { slug: "signed" }, asks: [{ title: "More" }] },
				"Parley signed is contract: its asks do not change",
			],
			[{ type: "ask", action: "answer", caller: "user", answers: [{ id: 999, answer: "a" }] }, "Unknown ask: 999"],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ slug: "checked", n: 9, answer: "a" }] },
				"Parley checked has no ask 9",
			],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ slug: "ghost", n: 1, answer: "a" }] },
				"Unknown parley: ghost",
			],
			[
				{
					type: "ask",
					action: "answer",
					caller: "user",
					answers: [
						{ id: call, answer: "a" },
						{ slug: "checked", n: 1, answer: "b" },
					],
				},
				`Ask ${call} has two answers in one write`,
			],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ id: call, answer: "c" }] },
				`Ask ${call} takes a, b or own`,
			],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ id: readBack, answer: "a" }] },
				`Ask ${readBack} takes ok or own`,
			],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ id: lone, answer: "ok" }] },
				`Ask ${lone} takes a, b or own`,
			],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ id: plain, answer: "own", label: "L" }] },
				`Ask ${plain} is dropped: it takes no answer`,
			],
			// The first answer is valid; the write fails as a whole.
			[
				{
					type: "ask",
					action: "answer",
					caller: "user",
					answers: [
						{ id: lone, answer: "a" },
						{ id: readBack, answer: "ok" },
					],
				},
				`Parley checked cannot be a contract: ask 1 is open`,
			],
			[
				{
					type: "ask",
					action: "answer",
					caller: "user",
					answers: [{ id: senseless, answer: "ok" }],
				},
				"Parley no-sense-yet cannot be a contract: design_sense is not set",
			],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ id: contract.call, answer: "b" }] },
				"Parley signed is contract: its asks do not change",
			],
			[
				{ type: "ask", action: "drop", caller: "pi-1", slug: "signed", n: 1 },
				"Parley signed is contract: its asks do not change",
			],
			[{ type: "ask", action: "drop", caller: "khan", id: plain }, `Ask ${plain} is dropped: only an open ask drops`],
			[{ type: "ask", action: "drop", caller: "khan", id: 999 }, "Unknown ask: 999"],
			[{ type: "parley", action: "take", caller: "pi-2", slug: "ghost" }, "Unknown parley: ghost"],
			[{ type: "parley", action: "read", slug: "ghost" }, "Unknown parley: ghost"],
			[{ type: "ask", action: "read", id: 999 }, "Unknown ask: 999"],
			[{ type: "ask", action: "read", slug: "checked", n: 9 }, "Parley checked has no ask 9"],
			[
				{ type: "parley", action: "end", caller: "pi-1", slug: "checked", status: "done" },
				"Parley checked is open: only a contract ends",
			],
		];

		for (const [line, error] of refused) await expect(send(line)).rejects.toThrow(error);

		// The checks inside one request run at the boundary.
		const badLines: [unknown, string][] = [
			[{ type: "ask", action: "round", caller: "pi-1", asks: [] }, "Invalid ask request: asks is not valid"],
			[
				{ type: "ask", action: "round", caller: "pi-1", asks: [{ title: "Use `git`" }] },
				"Invalid ask request: asks is not valid",
			],
			[
				{ type: "ask", action: "round", caller: "pi-1", asks: [{ title: "T", options: OPTIONS, plan: "c" }] },
				"Invalid ask request: asks is not valid",
			],
			[
				{ type: "ask", action: "round", caller: "pi-1", asks: [{ title: "T", options: [OPTIONS[1], OPTIONS[1]] }] },
				"Invalid ask request: asks is not valid",
			],
			[
				{
					type: "ask",
					action: "round",
					caller: "pi-1",
					parley: { slug: "Bad Slug", title: "T", goal: "G." },
					asks: [{ title: "T" }],
				},
				"Invalid ask request: parley is not valid",
			],
			[{ type: "ask", action: "round", asks: [{ title: "T" }] }, "Invalid ask request: caller is required"],
			[
				{ type: "ask", action: "drop", caller: "pi-1", id: call, slug: "checked", n: 1 },
				"Invalid ask request: id is not allowed",
			],
			[{ type: "ask", action: "read", slug: "checked" }, "Invalid ask request: n is required"],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ id: call, answer: "own" }] },
				"Invalid ask request: label is required",
			],
			[
				{
					type: "ask",
					action: "answer",
					caller: "user",
					answers: [
						{ id: call, answer: "a" },
						{ id: call, answer: "b" },
					],
				},
				"Invalid ask request: answers is not valid",
			],
			[
				{ type: "parley", action: "end", caller: "pi-1", slug: "signed", status: "open" },
				"Invalid parley request: status is not valid",
			],
		];

		for (const [line, error] of badLines) await expect(send(JSON.parse(JSON.stringify(line)))).rejects.toThrow(error);

		expect({ ...(await stored()), asks: await everyAsk() }).toEqual(before);
	});

	it("gives the state of an ask after each event", () => {
		const states: AskState[] = ["open", "answered", "dropped"];
		const events: AskEvent[] = ["answer", "drop"];
		const table = states.map((state) => [state, events.map((event) => askTransition(state, event))]);

		expect(table).toEqual([
			["open", ["answered", "dropped"]],
			["answered", ["answered", undefined]],
			["dropped", [undefined, undefined]],
		]);
	});
});

/** Every ask: the asks of each parley, and the open asks of no parley. */
async function everyAsk(): Promise<ParleyAsks[]> {
	const { parleys } = Value.Parse(ParleyList, await send({ type: "parley", action: "list" }));

	return Promise.all(parleys.map((parley) => readParley(parley.slug)));
}
