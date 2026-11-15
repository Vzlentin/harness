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
import { Ask, AskList, AskWrite, ParleyAsks } from "../src/protocol/project.ts";
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

/** The store of the host that runs. */
let store: Harness | undefined;

type RoundLine = Extract<Request, { type: "ask"; action: "round" }>;

/** Sends `line` to the host through the socket. */
async function send<T extends Request["type"]>(line: Extract<Request, { type: T }>): Promise<Replies[T]> {
	const reply = await request(line, { start: false });

	if (reply === undefined) throw new Error("no host");

	return reply;
}

/**
 * Writes a round of `asks` as the caller `caller`, for the parley `parley` when it is given, and gives the IDs of the
 * asks of the parley, or of the new asks with no parley.
 */
async function round(caller: string, asks: RoundLine["asks"], parley?: RoundLine["parley"]): Promise<number[]> {
	const line = parley === undefined ? { asks } : { parley, asks };
	const written = Value.Parse(AskWrite, await send({ type: "ask", action: "round", caller, ...line }));

	return [...written.parleys.flatMap((each) => each.asks), ...written.asks].map((ask) => ask.id);
}

/** Writes `answers` as the caller `caller`. The caller `user` marks them as answers of the user. */
async function answer(
	answers: Extract<Request, { type: "ask"; action: "answer" }>["answers"],
	caller = "user",
): Promise<void> {
	const line = { type: "ask", action: "answer", caller, answers } as const;

	await send(caller === "user" ? { ...line, user: true } : line);
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

/** Starts the host, and keeps it in `host` and the store that it opened in `store`. */
async function start(): Promise<void> {
	const open = Harness.open.bind(Harness);
	let opened: Harness | undefined;

	const spy = vi.spyOn(Harness, "open").mockImplementationOnce(async (...args) => {
		opened = await open(...args);

		return opened;
	});

	try {
		host = await startHost();
	} finally {
		spy.mockRestore();
	}

	if (opened === undefined) throw new Error("no store");
	store = opened;
}

/** Stops the host, and starts it again. */
async function restart(): Promise<void> {
	await host?.close();
	await start();
}

const OPTIONS = [
	{ key: "a", label: "In the store" },
	{ key: "b", label: "In files" },
];

const FRAME = { title: "Ship plan", goal: "Pick the place.", design_sense: "One writer." };

beforeAll(async () => {
	await setUp();
	await start();
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

		await restart();
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
		await restart();
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

	it("gives the answers of a contract that waited to its taker, and nothing to the old asker", async () => {
		const [call, readBack] = await round(
			"pi-gone",
			[{ title: "Where", kind: "your call", options: OPTIONS, plan: "a" }, { title: "These are the terms" }],
			{ slug: "signed-away", ...FRAME },
		);

		await answer([
			{ id: call ?? 0, answer: "a" },
			{ id: readBack ?? 0, answer: "ok" },
		]);

		const taken = Value.Parse(
			ParleyAsks,
			await send({ type: "parley", action: "take", caller: "pi-new", slug: "signed-away" }),
		);

		expect(taken.parley.status).toBe("contract");
		expect(taken.asks).toMatchObject([
			{ id: call, answer: "a", asker: "pi-gone" },
			{ id: readBack, answer: "ok", asker: "pi-gone" },
		]);

		const answers = listen("pi-gone");

		try {
			const [marker] = await round("pi-gone", [{ title: "Marker" }]);
			await answer([{ id: marker ?? 0, answer: "own", label: "Yes" }]);
			await untilCount(answers.deliveries, 1);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(answers.deliveries).toMatchObject([{ source: "ask", ask: marker }]);
		} finally {
			answers.listener.close();
		}
	});

	it("goes to an idle hosted asker of a parley as input that starts a turn", async () => {
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
		const turn = calls.find((call) => call.prompt.startsWith(head))?.prompt ?? "";
		expect(turn).toContain("1 · Hosted ask · own · Go\n");
		// A new turn of an idle asker: the message before the answer is the last answer of the model.
		expect(before.get(turn)).toBe("assistant");
	});

	it("goes to an idle hosted asker of an ask with no parley as input that starts a turn", async () => {
		const prompt = "Task:\nAsk alone";
		scripts.set(prompt, [{ name: "parley", arguments: { action: "round", asks: [{ title: "Idle lone" }] } }]);
		await spawnAs("lone-spawner", prompt, { notify: false });
		await until(() => (cellResults.get(prompt) ?? []).length === 1);
		const lone = await askTitled("Idle lone");
		await answer([{ id: lone.id, answer: "own", label: "Fine" }]);
		const turn = `the user answered ask ${lone.id}\n\n${lone.id} · Idle lone · own · Fine\n`;
		await until(() => called(turn) === 1);
		expect(before.get(turn)).toBe("assistant");
	});

	it("goes to a working hosted asker of a parley as a follow-up", async () => {
		const prompt = "Task:\nAsk in a parley while working";
		const go = join(root, "working-parley-go");

		scripts.set(prompt, [
			{ name: "parley", arguments: { action: "round", slug: "working", ...FRAME, asks: [{ title: "Working ask" }] } },
			{ name: "bash", arguments: { command: `while [ ! -f ${go} ]; do sleep 0.05; done` } },
		]);
		await spawnAs("working-spawner", prompt, { notify: false });
		await until(() => (cellResults.get(prompt) ?? []).length === 1);
		const [asked] = (await readParley("working")).asks;

		if (asked === undefined) throw new Error("no ask");
		await answer([{ id: asked.id, answer: "own", label: "Go" }]);
		const head = "the user answered the parley working";
		await followsUp(asked.asker, go, () => calls.some((call) => call.prompt.startsWith(head)));
		const turn = calls.find((call) => call.prompt.startsWith(head))?.prompt ?? "";
		expect(turn).toContain("1 · Working ask · own · Go\n");
		// A follow-up waits for the end of the turn: the message before the answer is an answer of the model.
		expect(before.get(turn)).toBe("assistant");
	});

	it("goes to a working hosted asker of an ask with no parley as a follow-up", async () => {
		const prompt = "Task:\nAsk alone while working";
		const go = join(root, "working-lone-go");

		scripts.set(prompt, [
			{ name: "parley", arguments: { action: "round", asks: [{ title: "Working lone" }] } },
			{ name: "bash", arguments: { command: `while [ ! -f ${go} ]; do sleep 0.05; done` } },
		]);
		await spawnAs("working-lone-spawner", prompt, { notify: false });
		await until(() => (cellResults.get(prompt) ?? []).length === 1);
		const lone = await askTitled("Working lone");
		await answer([{ id: lone.id, answer: "own", label: "Later" }]);
		const turn = `the user answered ask ${lone.id}\n\n${lone.id} · Working lone · own · Later\n`;
		await followsUp(lone.asker, go, () => called(turn) === 1);
		expect(before.get(turn)).toBe("assistant");
	});

	it("resumes a hosted asker that was stopped with the answer of the user", async () => {
		const prompt = "Task:\nAsk then close";
		const ask = { action: "round", slug: "closed", ...FRAME, asks: [{ title: "Closed ask" }] };
		scripts.set(prompt, [{ name: "parley", arguments: ask }]);
		const child = await spawnAs("closed-spawner", prompt, { notify: false });
		await until(() => (cellResults.get(prompt) ?? []).length === 1);
		await send({ type: "stop", caller: "closed-spawner", handle: child.handle });
		const [closed] = (await readParley("closed")).asks;

		if (closed === undefined) throw new Error("no ask");
		await answer([{ id: closed.id, answer: "own", label: "Go" }]);
		await until(() => calls.some((call) => call.prompt.startsWith("the user answered the parley closed")));
		expect((await send({ type: "status", handle: child.handle })).state).not.toBe("ended");
	});

	it("does not go again to a hosted asker after a restart of the host", async () => {
		const prompt = "Task:\nAsk once";
		scripts.set(prompt, [{ name: "parley", arguments: { action: "round", asks: [{ title: "Hosted once" }] } }]);
		await spawnAs("once-spawner", prompt, { notify: false });
		await until(() => (cellResults.get(prompt) ?? []).length === 1);
		const once = await askTitled("Hosted once");
		await answer([{ id: once.id, answer: "own", label: "Yes" }]);
		const turn = `the user answered ask ${once.id}\n\n${once.id} · Hosted once · own · Yes\n`;
		await until(() => called(turn) === 1);

		await restart();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(called(turn)).toBe(1);
	});
});

/** The open ask with the title `title`. */
async function askTitled(title: string): Promise<Ask> {
	const ask = Value.Parse(AskList, await send({ type: "ask", action: "list" })).asks.find(
		(each) => each.title === title,
	);

	if (ask === undefined) throw new Error(`no ask ${title}`);

	return ask;
}

/**
 * Waits until the host gave the answers of `asker` while it works in a bash call that waits for the file `go`, checks
 * that no turn of the answers started, then ends the bash call and waits until `delivered()`.
 */
async function followsUp(asker: string, go: string, delivered: () => boolean): Promise<void> {
	const waiting = async () =>
		(await readUserAnswers(currentStore(), BACKGROUND_CONTEXT)).filter((each) => each.asker === asker);

	await vi.waitFor(async () => expect(await waiting()).toEqual([]), { timeout: 10_000 });
	expect(delivered()).toBe(false);
	await writeFile(go, "");
	await until(delivered);
}

/** The store of the host that runs. */
function currentStore(): Harness {
	if (store === undefined) throw new Error("no store");

	return store;
}
