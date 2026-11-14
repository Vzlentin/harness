import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { AnswerListener } from "../src/client/answers.ts";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { readUserAnswers } from "../src/host/user-answers.ts";
import { deliveryText } from "../src/protocol/labels.ts";
import { AskList, ParleyAsks } from "../src/protocol/project.ts";
import type { Delivery, Replies, Request } from "../src/protocol/requests.ts";
import {
	before,
	called,
	calls,
	cellResults,
	root,
	scripts,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

let host: Host | undefined;

type RoundLine = Extract<Request, { type: "ask"; action: "round" }>;

/** Sends `line` to the host through the socket. */
async function send<T extends Request["type"]>(line: Extract<Request, { type: T }>): Promise<Replies[T]> {
	const reply = await request(line, { start: false });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/** Writes a round of `asks` as the caller `caller`, for the parley `parley` when it is given, and gives the ask IDs. */
async function round(caller: string, asks: RoundLine["asks"], parley?: RoundLine["parley"]): Promise<number[]> {
	const line = parley === undefined ? { asks } : { parley, asks };
	const written = await send({ type: "ask", action: "round", caller, ...line });

	if (!("asks" in written)) throw new Error("no asks");

	return written.asks.map((ask) => ask.id);
}

/** Writes `answers` as the caller `caller`. */
async function answer(
	answers: Extract<Request, { type: "ask"; action: "answer" }>["answers"],
	caller = "user",
): Promise<void> {
	await send({ type: "ask", action: "answer", caller, answers });
}

async function readParley(slug: string): Promise<ParleyAsks> {
	return Value.Parse(ParleyAsks, await send({ type: "parley", action: "read", slug }));
}

/** An `answers` listener, and every delivery that it gave. */
type Listened = { readonly deliveries: Delivery[]; readonly listener: AnswerListener };

/** The `answers` listener of `caller`, as the Pi extension opens it, with every delivery that came. */
function listen(caller: string): Listened {
	const deliveries: Delivery[] = [];

	const listener = new AnswerListener(caller, (delivery) => deliveries.push(delivery), {
		start: false,
		retryDelaysMs: [0, 200, 500],
		onError: () => {},
	});

	return { deliveries, listener };
}

/** Waits until `deliveries` has `count` deliveries. */
async function untilCount(deliveries: readonly Delivery[], count: number): Promise<void> {
	await vi.waitFor(() => expect(deliveries).toHaveLength(count), { timeout: 10_000 });
}

/** Restarts the host, and gives the store that it opened. */
async function restartWithStore(): Promise<Harness> {
	await host?.close();
	const open = Harness.open.bind(Harness);
	let store: Harness | undefined;

	const opened = vi.spyOn(Harness, "open").mockImplementationOnce(async (...args) => {
		store = await open(...args);

		return store;
	});

	try {
		host = await startHost();
	} finally {
		opened.mockRestore();
	}

	if (store === undefined) throw new Error("no store");

	return store;
}

const OPTIONS = [
	{ key: "a", label: "In the store" },
	{ key: "b", label: "In files" },
];

const FRAME = { title: "Ship plan", goal: "Pick the place.", design_sense: "One writer." };

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the answers of the user", { timeout: 30_000 }, () => {
	it("goes to the asker of an ask with no parley, with its line and the words of the user", async () => {
		const answers = listen("pi-lone");

		try {
			const [id] = await round("pi-lone", [{ title: "Push now?" }]);
			await answer([{ id: id ?? 0, answer: "own", label: "Not yet", words: ["wait for CI"] }]);
			await untilCount(answers.deliveries, 1);
			const text = `${id} · Push now? · own · Not yet\nwait for CI\n`;
			expect(answers.deliveries).toEqual([{ source: "ask", ask: id, text }]);
			expect(answers.deliveries.map(deliveryText)).toEqual([`the user answered ask ${id}\n\n${text}`]);
		} finally {
			answers.listener.close();
		}
	});

	it("goes to the asker of a parley once for one write, with the text of the parley after it", async () => {
		const answers = listen("pi-parley");

		try {
			const ids = await round(
				"pi-parley",
				[{ title: "Where", kind: "your call", options: OPTIONS, plan: "a" }, { title: "These are the terms" }],
				{ slug: "ship-plan", ...FRAME },
			);

			const [call, readBack] = ids;
			await answer([
				{ id: call ?? 0, answer: "a" },
				{ id: readBack ?? 0, answer: "ok" },
			]);
			await untilCount(answers.deliveries, 1);

			const text = [
				"ship-plan · contract · Ship plan",
				"1 · Where · your call · a · In the store",
				"2 · These are the terms · ok",
				"harness parley show ship-plan",
			]
				.map((line) => `${line}\n`)
				.join("");

			expect(answers.deliveries).toEqual([{ source: "parley", parley: "ship-plan", asks: ids, text }]);
			expect(deliveryText(answers.deliveries[0] ?? { source: "ask", ask: 0, text: "" })).toBe(
				`the user answered the parley ship-plan\n\n${text}`,
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(answers.deliveries).toHaveLength(1);
		} finally {
			answers.listener.close();
		}
	});

	it("does not go to an asker that answered its own ask", async () => {
		const answers = listen("pi-self");

		try {
			const [own] = await round("pi-self", [{ title: "Mine" }]);
			await answer([{ id: own ?? 0, answer: "own", label: "Done" }], "pi-self");
			// A later answer of the user must come first and alone.
			const [marker] = await round("pi-self", [{ title: "Marker" }]);
			await answer([{ id: marker ?? 0, answer: "own", label: "Yes" }]);
			await untilCount(answers.deliveries, 1);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(answers.deliveries).toMatchObject([{ source: "ask", ask: marker }]);
		} finally {
			answers.listener.close();
		}
	});

	it("does not go again to a Pi asker after a restart of the host", async () => {
		const first = listen("pi-once");

		try {
			const [id] = await round("pi-once", [{ title: "Once" }]);
			await answer([{ id: id ?? 0, answer: "own", label: "Yes" }]);
			await untilCount(first.deliveries, 1);
		} finally {
			first.listener.close();
		}

		await host?.close();
		host = await startHost();
		const again = listen("pi-once");

		try {
			const [marker] = await round("pi-once", [{ title: "Marker" }]);
			await answer([{ id: marker ?? 0, answer: "own", label: "Yes" }]);
			await untilCount(again.deliveries, 1);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(again.deliveries).toMatchObject([{ source: "ask", ask: marker }]);
		} finally {
			again.listener.close();
		}
	});

	it("waits for an asker with no listener, also over a restart of the host", async () => {
		const [id] = await round("pi-later", [{ title: "Later" }]);
		await answer([{ id: id ?? 0, answer: "own", label: "Fine" }]);
		await host?.close();
		host = await startHost();
		const answers = listen("pi-later");

		try {
			await untilCount(answers.deliveries, 1);
			expect(answers.deliveries).toMatchObject([{ source: "ask", ask: id, text: `${id} · Later · own · Fine\n` }]);
		} finally {
			answers.listener.close();
		}
	});

	it("gives the waiting answers of a parley to its taker, and no more to the old asker", async () => {
		const [first] = await round("pi-old", [{ title: "First" }, { title: "Second" }], { slug: "taken", ...FRAME });
		await answer([{ id: first ?? 0, answer: "own", label: "Yes" }]);

		const taken = Value.Parse(
			ParleyAsks,
			await send({ type: "parley", action: "take", caller: "pi-new", slug: "taken" }),
		);

		expect(taken.asks).toMatchObject([{ id: first, state: "answered", label: "Yes" }, { asker: "pi-new" }]);
		const answers = listen("pi-old");

		try {
			const [marker] = await round("pi-old", [{ title: "Marker" }]);
			await answer([{ id: marker ?? 0, answer: "own", label: "Yes" }]);
			await untilCount(answers.deliveries, 1);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(answers.deliveries).toMatchObject([{ source: "ask", ask: marker }]);
		} finally {
			answers.listener.close();
		}
	});

	it("goes to a hosted asker as input that starts a turn, and waits while the asker is closed", async () => {
		const prompt = "Task:\nAsk the user";
		const ask = { action: "round", slug: "hosted", ...FRAME, asks: [{ title: "Hosted ask" }] };
		scripts.set(prompt, [{ name: "parley", arguments: ask }]);
		await spawnAs("hosted-spawner", prompt, { notify: false });
		await until(() => (cellResults.get(prompt) ?? []).length === 1);
		const [hosted] = (await readParley("hosted")).asks;

		if (hosted === undefined) throw new Error("no ask");
		await answer([{ id: hosted.id, answer: "own", label: "Go" }]);
		const head = "the user answered the parley hosted\n\n";
		await until(() => calls.some((call) => call.prompt.startsWith(head)));
		expect(calls.find((call) => call.prompt.startsWith(head))?.prompt).toContain("1 · Hosted ask · own · Go\n");

		const closedPrompt = "Task:\nAsk then close";
		const closedAsk = { action: "round", slug: "closed", ...FRAME, asks: [{ title: "Closed ask" }] };
		scripts.set(closedPrompt, [{ name: "parley", arguments: closedAsk }]);
		const closedChild = await spawnAs("hosted-spawner", closedPrompt, { notify: false });
		await until(() => (cellResults.get(closedPrompt) ?? []).length === 1);
		await send({ type: "stop", caller: "hosted-spawner", handle: closedChild.handle });
		const [closedId] = (await readParley("closed")).asks.map(({ id }) => id);
		await answer([{ id: closedId ?? 0, answer: "own", label: "Go" }]);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(calls.some((call) => call.prompt.startsWith("the user answered the parley closed"))).toBe(false);
	});

	it("goes to a working hosted asker as follow-ups, and not again after a restart of the host", async () => {
		const prompt = "Task:\nAsk while working";
		const go = join(root, "working-go");

		scripts.set(prompt, [
			{ name: "parley", arguments: { action: "round", slug: "working", ...FRAME, asks: [{ title: "Working ask" }] } },
			{ name: "parley", arguments: { action: "round", asks: [{ title: "Working lone" }] } },
			{ name: "bash", arguments: { command: `while [ ! -f ${go} ]; do sleep 0.05; done` } },
		]);
		const store = await restartWithStore();
		await spawnAs("working-spawner", prompt, { notify: false });
		// The model is in the bash call once it saw the results of both rounds.
		await until(() => (cellResults.get(prompt) ?? []).length === 2);
		const [parleyAsk] = (await readParley("working")).asks;

		const lone = Value.Parse(AskList, await send({ type: "ask", action: "list" })).asks.find(
			(ask) => ask.title === "Working lone",
		);

		if (parleyAsk === undefined || lone === undefined) throw new Error("no asks");
		await answer([
			{ id: parleyAsk.id, answer: "own", label: "Go" },
			{ id: lone.id, answer: "own", label: "Later" },
		]);

		// The host gives both to the asker while it works, and no turn starts before its bash call ends.
		const waiting = async () =>
			(await readUserAnswers(store, BACKGROUND_CONTEXT)).filter(({ asker }) => asker === parleyAsk.asker);

		await vi.waitFor(async () => expect(await waiting()).toEqual([]), { timeout: 10_000 });

		const parleyPrompt = calls.find((call) => call.prompt.startsWith("the user answered the parley working"));
		expect(parleyPrompt).toBeUndefined();
		await writeFile(go, "");
		const lonePrompt = `the user answered ask ${lone.id}\n\n${lone.id} · Working lone · own · Later\n`;
		await until(() => called(lonePrompt) === 1);
		const working = calls.find((call) => call.prompt.startsWith("the user answered the parley working"))?.prompt;

		if (working === undefined) throw new Error("no parley turn");
		expect(working).toContain("1 · Working ask · own · Go\n");
		// A follow-up waits for the end of the turn: the message before each answer is an answer of the model.
		expect(before.get(working)).toBe("assistant");
		expect(before.get(lonePrompt)).toBe("assistant");

		await host?.close();
		host = await startHost();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(called(working)).toBe(1);
		expect(called(lonePrompt)).toBe(1);
	});
});
