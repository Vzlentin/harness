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
import { answer, framed, OPTIONS, round, send, setUp, startHost, tearDown, unlinkContract } from "./helpers.ts";

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
					asks: [
						{
							id: 1,
							state: "answered",
							answer: "own",
							label: "In the store, with a view",
							by: "user",
							author: { kind: "user" },
						},
						{},
						{},
					],
				},
			],
			asks: [{ id: 3, state: "answered", answer: "own", label: "Not yet", author: { kind: "user" } }],
		});

		// A new answer replaces the answer, the label and the words as one unit.
		const replaced = (await answer([{ id: 1, answer: "b" }])).parleys[0]?.asks[0];
		expect(replaced).toEqual({
			...first.parleys[0]?.asks[0],
			state: "answered",
			answer: "b",
			at: replaced?.at,
			by: "user",
			author: { kind: "user" },
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

	it("records the author of each answer: the user with the mark, else the agent of the caller", async () => {
		const lone = (await round("khan", undefined, [{ title: "Who answers?" }])).asks[0]?.id ?? 0;
		const byUser = (await answer([{ id: lone, answer: "own", label: "Me" }])).asks[0];
		expect(byUser).toMatchObject({ by: "user", author: { kind: "user" } });

		// A note keeps the author of the answer, and changes only `by`.
		const noted = await send({ type: "ask", action: "note", caller: "khan", id: lone, note: "who" });
		expect(noted).toMatchObject({ by: "khan", author: { kind: "user" } });

		// A new answer with no mark writes its own author.
		const byAgent = Value.Parse(
			AskWrite,
			await send({
				type: "ask",
				action: "answer",
				caller: "pi-1",
				answers: [{ id: lone, answer: "own", label: "It" }],
			}),
		).asks[0];

		expect(byAgent).toMatchObject({ by: "pi-1", author: { kind: "agent", caller: "pi-1" }, note: "who" });
		expect(await send({ type: "ask", action: "read", id: lone })).toEqual(byAgent);
	});

	it("records the vault note of an ask in any state, by its ID or by its number in its parley", async () => {
		const lone = (await round("khan", undefined, [{ title: "Note it?" }])).asks[0]?.id ?? 0;
		const answered = (await answer([{ id: lone, answer: "own", label: "Yes" }])).asks[0];
		const { call, readBack } = await framed("noted");

		const noted = await send({ type: "ask", action: "note", caller: "khan", id: lone, note: "20261115-ask" });
		expect(noted).toEqual({ ...answered, note: "20261115-ask", at: Value.Parse(Ask, noted).at, by: "khan" });
		expect(await send({ type: "ask", action: "read", id: lone })).toEqual(noted);

		// A second note replaces the first, and the note of an open ask of a parley stays after its answer.
		await send({ type: "ask", action: "note", caller: "pi-1", slug: "noted", n: 1, note: "first" });

		const second = Value.Parse(
			Ask,
			await send({ type: "ask", action: "note", caller: "pi-1", slug: "noted", n: 1, note: "second note" }),
		);

		expect(second).toMatchObject({ id: call, state: "open", note: "second note", asker: "pi-1", by: "pi-1" });
		const read = await readParley("noted");
		expect(read.asks[0]).toEqual(second);
		expect(read.asks[1]).not.toHaveProperty("note");

		await answer([{ id: call, answer: "a" }]);
		const kept = Value.Parse(Ask, await send({ type: "ask", action: "read", slug: "noted", n: 1 }));
		expect(kept).toMatchObject({ state: "answered", answer: "a", note: "second note" });
		expect(Value.Parse(Ask, await send({ type: "ask", action: "read", id: readBack }))).not.toHaveProperty("note");
	});

	it("records the vault note of an ask only for its asker", async () => {
		const lone = (await round("khan", undefined, [{ title: "Whose note?" }])).asks[0]?.id ?? 0;

		await expect(send({ type: "ask", action: "note", caller: "pi-2", id: lone, note: "theirs" })).rejects.toThrow(
			`Ask ${lone} was asked by another caller: only its asker records its note`,
		);

		const read = Value.Parse(Ask, await send({ type: "ask", action: "read", id: lone }));
		expect(read).toMatchObject({ id: lone, state: "open", asker: "khan", by: "khan" });
		expect(read).not.toHaveProperty("note");
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

	it("ends a contract that shapes no item as done or dropped, and not an open parley", async () => {
		for (const status of ["done", "dropped"] as const) {
			const slug = `ends-${status}`;
			const { call, readBack } = await framed(slug);
			const end = { type: "parley", action: "end", caller: "pi-1", slug, status } as const;

			await expect(send(end)).rejects.toThrow(`Parley ${slug} is open: only a contract ends`);
			await answer([
				{ id: call, answer: "a" },
				{ id: readBack, answer: "ok" },
			]);
			await unlinkContract(slug);

			const ended = Value.Parse(Parley, await send(end));
			expect(ended).toMatchObject({ slug, status, by: "pi-1" });
			expect((await readParley(slug)).parley).toEqual(ended);
			await expect(send(end)).rejects.toThrow(`Parley ${slug} is ${status}: only a contract ends`);
		}
	});

	it("changes the frame of an open parley with a round that has no asks", async () => {
		await framed("reframed");
		const before = await readParley("reframed");
		const evidence = ["The store has one writer."];
		const written = await round("pi-2", { slug: "reframed", evidence }, []);

		expect(written.asks).toEqual([]);
		expect(written.parleys).toEqual([
			{ parley: { ...before.parley, evidence, at: expect.any(Number), by: "pi-2" }, asks: before.asks },
		]);
		expect(await readParley("reframed")).toEqual(written.parleys[0]);
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
			[{ type: "ask", action: "note", caller: "pi-1", id: 999, note: "n" }, "Unknown ask: 999"],
			[
				{ type: "ask", action: "note", caller: "pi-1", slug: "checked", n: 9, note: "n" },
				"Parley checked has no ask 9",
			],
			[{ type: "ask", action: "read", slug: "checked", n: 9 }, "Parley checked has no ask 9"],
			[
				{ type: "parley", action: "end", caller: "pi-1", slug: "checked", status: "done" },
				"Parley checked is open: only a contract ends",
			],
			[
				{
					type: "ask",
					action: "round",
					caller: "pi-1",
					parley: { slug: "checked", title: "Where asks live", design_sense: "One writer." },
					asks: [],
				},
				"A round with no asks must change the title, goal, evidence or design sense of the open parley checked",
			],
			[
				{
					type: "ask",
					action: "round",
					caller: "pi-1",
					parley: { slug: "fresh", title: "Fresh", goal: "Pick." },
					asks: [],
				},
				"A round with no asks must change the title, goal, evidence or design sense of the open parley fresh",
			],
			[
				{ type: "ask", action: "round", caller: "pi-1", parley: { slug: "checked" }, item: 1, asks: [] },
				"A round with no asks must change the title, goal, evidence or design sense of the open parley checked",
			],
		];

		for (const [line, error] of refused) await expect(send(line)).rejects.toThrow(error);

		// The checks inside one request run at the boundary.
		const badLines: [unknown, string][] = [
			[
				{ type: "ask", action: "round", caller: "pi-1", asks: [] },
				"Invalid ask request: asks: must not have fewer than 1 items",
			],
			[
				{ type: "ask", action: "round", caller: "pi-1", asks: [{ title: "Use `git`" }] },
				"Invalid ask request: asks/0/title: plain text, no backticks or **",
			],
			[
				{
					type: "ask",
					action: "round",
					caller: "pi-1",
					asks: [
						{
							title: "T",
							options: [
								{ key: "a", label: "x" },
								{ key: "b", label: "Use `git`" },
							],
						},
					],
				},
				"Invalid ask request: asks/0/options/1/label: plain text, no backticks or **",
			],
			[
				{ type: "ask", action: "round", caller: "pi-1", asks: [{ title: "T", options: OPTIONS, plan: "c" }] },
				"Invalid ask request: asks/0: must have unique option keys and a plan that is one of them",
			],
			[
				{ type: "ask", action: "round", caller: "pi-1", asks: [{ title: "T", options: [OPTIONS[1], OPTIONS[1]] }] },
				"Invalid ask request: asks/0: must have unique option keys and a plan that is one of them",
			],
			[
				{
					type: "ask",
					action: "round",
					caller: "pi-1",
					parley: { slug: "Bad Slug", title: "T", goal: "G." },
					asks: [{ title: "T" }],
				},
				'Invalid ask request: parley/slug: must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$"',
			],
			[{ type: "ask", action: "round", asks: [{ title: "T" }] }, "Invalid ask request: caller: required"],
			[
				{ type: "ask", action: "drop", caller: "pi-1", id: call, slug: "checked", n: 1 },
				"Invalid ask request: id: not allowed",
			],
			[{ type: "ask", action: "read", slug: "checked" }, "Invalid ask request: n: required"],
			[{ type: "ask", action: "note", caller: "pi-1", id: call }, "Invalid ask request: note: required"],
			[
				{ type: "ask", action: "note", caller: "pi-1", id: call, note: "" },
				'Invalid ask request: note: must match pattern "\\S"',
			],
			[
				{ type: "ask", action: "note", caller: "pi-1", id: call, note: "  " },
				'Invalid ask request: note: must match pattern "\\S"',
			],
			[
				{ type: "ask", action: "note", caller: "pi-1", id: call, slug: "checked", n: 1, note: "n" },
				"Invalid ask request: id: not allowed",
			],
			[
				{ type: "ask", action: "answer", caller: "user", answers: [{ id: call, answer: "own" }] },
				"Invalid ask request: answers/0/label: required",
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
				"Invalid ask request: answers: must answer each ask once",
			],
			[
				{ type: "parley", action: "end", caller: "pi-1", slug: "signed", status: "open" },
				"Invalid parley request: status: must be equal to constant",
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
