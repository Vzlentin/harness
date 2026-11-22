import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { AnswerListener } from "../src/client/answers.ts";
import type { Host } from "../src/host/run.ts";
import { readUserAnswers } from "../src/host/user-answers.ts";
import { deliveryText } from "../src/protocol/labels.ts";
import type { Delivery, Request } from "../src/protocol/requests.ts";
import {
	before,
	called,
	degradedStates,
	root,
	round,
	scripts,
	send,
	setUp,
	spawnAs,
	spawnWithId,
	startHost,
	tearDown,
	until,
	untilState,
} from "./helpers.ts";

let host: Host | undefined;

/** The store of the host that runs. */
let store: Harness | undefined;

/** Writes an ask with no parley with the title `title` as the caller `caller`, and gives its ID. */
async function ask(caller: string, title: string): Promise<number> {
	const id = (await round(caller, undefined, [{ title }])).asks[0]?.id;

	if (id === undefined) throw new Error("no ask");

	return id;
}

/** Writes `answers` as the caller `caller`. The caller `user` marks them as answers of the user. */
async function answer(
	answers: Extract<Request, { type: "ask"; action: "answer" }>["answers"],
	caller = "user",
): Promise<void> {
	const line = { type: "ask", action: "answer", caller, answers } as const;

	await send(caller === "user" ? { ...line, user: true } : line);
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
			const id = await ask("pi-lone", "Push now?");
			await answer([{ id, answer: "own", label: "Not yet", words: ["wait for CI"] }]);
			await untilCount(answers.deliveries, 1);
			const text = `${id} · Push now? · own · Not yet\nwait for CI\n`;
			expect(answers.deliveries).toEqual([{ source: "ask", ask: id, text }]);
			expect(answers.deliveries.map(deliveryText)).toEqual([`the user answered ask ${id}\n\n${text}`]);
		} finally {
			answers.listener.close();
		}
	});

	it("does not go to an asker that answered its own ask", async () => {
		const answers = listen("pi-self");

		try {
			const own = await ask("pi-self", "Mine");
			await answer([{ id: own, answer: "own", label: "Done" }], "pi-self");
			// A later answer of the user must come first and alone.
			const marker = await ask("pi-self", "Marker");
			await answer([{ id: marker, answer: "own", label: "Yes" }]);
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
			const id = await ask("pi-once", "Once");
			await answer([{ id, answer: "own", label: "Yes" }]);
			await untilCount(first.deliveries, 1);
		} finally {
			first.listener.close();
		}

		await restart();
		const again = listen("pi-once");

		try {
			const marker = await ask("pi-once", "Marker");
			await answer([{ id: marker, answer: "own", label: "Yes" }]);
			await untilCount(again.deliveries, 1);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(again.deliveries).toMatchObject([{ source: "ask", ask: marker }]);
		} finally {
			again.listener.close();
		}
	});

	it("waits for an asker with no listener, also over a restart of the host, as a degraded state", async () => {
		const line = "The answers of the user wait for pi-later, which has no answers request open";
		/** The degraded states of the answers for pi-later. */
		const waits = async () => (await degradedStates()).filter((state) => state.line === line);

		const id = await ask("pi-later", "Later");
		await answer([{ id, answer: "own", label: "Fine" }]);
		await vi.waitFor(
			async () => expect(await waits()).toEqual([{ kind: "answer-waits", line, since: expect.any(Number) }]),
			{ timeout: 10_000 },
		);
		await restart();
		const answers = listen("pi-later");

		try {
			await untilCount(answers.deliveries, 1);
			expect(answers.deliveries).toMatchObject([{ source: "ask", ask: id, text: `${id} · Later · own · Fine\n` }]);
			await vi.waitFor(async () => expect(await waits()).toEqual([]), { timeout: 10_000 });
		} finally {
			answers.listener.close();
		}
	});

	it("goes to an idle hosted asker as input that starts a turn", async () => {
		const { id: asker } = await spawnWithId("lone-spawner");
		const lone = await ask(asker, "Idle lone");
		await answer([{ id: lone, answer: "own", label: "Fine" }]);
		const turn = `the user answered ask ${lone}\n\n${lone} · Idle lone · own · Fine\n`;
		await until(() => called(turn) === 1);
		// A new turn of an idle asker: the message before the answer is the last answer of the model.
		expect(before.get(turn)).toBe("assistant");
	});

	it("goes to a working hosted asker as a follow-up", async () => {
		const prompt = "Task:\nAsk alone while working";
		const go = join(root, "working-lone-go");
		const idFile = join(root, "working-lone-id");
		const command = `echo "$PI_SESSION_ID" > ${idFile}.tmp && mv ${idFile}.tmp ${idFile}; while [ ! -f ${go} ]; do sleep 0.05; done`;
		scripts.set(prompt, [{ name: "bash", arguments: { command } }]);
		await spawnAs("working-lone-spawner", prompt, { notify: false });
		const asker = await vi.waitFor(async () => (await readFile(idFile, "utf8")).trim(), { timeout: 10_000 });
		const lone = await ask(asker, "Working lone");
		await answer([{ id: lone, answer: "own", label: "Later" }]);
		const turn = `the user answered ask ${lone}\n\n${lone} · Working lone · own · Later\n`;
		await followsUp(asker, go, () => called(turn) === 1);
		// A follow-up waits for the end of the turn: the message before the answer is an answer of the model.
		expect(before.get(turn)).toBe("assistant");
	});

	it("resumes a hosted asker that was stopped with the answer of the user", async () => {
		const { handle, id: asker } = await spawnWithId("closed-spawner");
		const closed = await ask(asker, "Closed ask");
		await send({ type: "stop", caller: "closed-spawner", handle });
		await untilState(handle, "ended");
		await answer([{ id: closed, answer: "own", label: "Go" }]);
		await until(() => called(`the user answered ask ${closed}\n\n${closed} · Closed ask · own · Go\n`) === 1);
		expect((await send({ type: "status", handle })).state).not.toBe("ended");
	});

	it("does not go again to a hosted asker after a restart of the host", async () => {
		const { id: asker } = await spawnWithId("once-spawner");
		const once = await ask(asker, "Hosted once");
		await answer([{ id: once, answer: "own", label: "Yes" }]);
		const turn = `the user answered ask ${once}\n\n${once} · Hosted once · own · Yes\n`;
		await until(() => called(turn) === 1);

		await restart();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(called(turn)).toBe(1);
	});
});

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
