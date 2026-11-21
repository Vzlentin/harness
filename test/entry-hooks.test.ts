import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Children, Place } from "../src/children/library.ts";
import { connect, request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { onLines } from "../src/protocol/lines.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { MAIN_PROJECT } from "../src/protocol/projects.ts";
import type { Delivery } from "../src/protocol/requests.ts";
import {
	answer,
	called,
	contexts,
	inputAgent,
	root,
	round,
	setSettings,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	until,
} from "./helpers.ts";

const TYPEBOX = import.meta.resolve("typebox");

/** What the entry of the tests shares with them, through `globalThis`, since it runs in this process. */
type Shared = {
	/** The conversations that the input hook saw, in order. */
	inputs: string[];
	/** The heads that the input hook saw, in order. */
	heads: (string | undefined)[];
	/** Whether the input hook writes a second entry, which fails. */
	twice: boolean;
	/** The children library and the place of the host, from the handles of the entry. */
	handles?: { readonly children: Children; readonly place: Place };
	/** The events that the handler of the answered asks got, in order. */
	events: { key: string; ask: { id: number } }[];
	/** What the handler does with an event after it records it. */
	handle: (event: { key: string }, options: { signal: AbortSignal }) => Promise<void>;
	/** The error of a delivery before the host opens. */
	beforeOpen: string;
};

const shared: Shared = { inputs: [], heads: [], twice: false, events: [], handle: async () => {}, beforeOpen: "" };

Object.assign(globalThis, { harnessEntryHooks: shared });

/** The entry of the tests: an input hook, a handler of the answered asks, and a request type that delivers. */
const HOOKS_ENTRY = `import { Type } from ${JSON.stringify(TYPEBOX)};
export default function hooksEntry(handles) {
	const shared = globalThis.harnessEntryHooks;
	shared.handles = handles;
	handles.deliver({ key: "early", to: "1", text: "Early" }).catch((error) => (shared.beforeOpen = error.message));
	return {
		extensions: [],
		input: {
			kind: "fixture",
			run: async ({ conversation, head, write }) => {
				shared.inputs.push(conversation);
				shared.heads.push(head);
				const key = String(shared.inputs.length);
				await write({ key, kind: "fixture.note", text: "Hook for " + conversation });
				if (shared.twice) await write({ key: key + "b", kind: "fixture.note", text: "Twice for " + conversation });
			},
		},
		answeredAsk: async (event, options) => {
			shared.events.push(event);
			await shared.handle(event, options);
		},
		requests: [
			{
				type: "fixture.deliver",
				schema: Type.Object({ key: Type.String(), to: Type.String(), text: Type.String() }),
				passive: () => false,
				handle: async ({ key, to, text }) => {
					await handles.deliver({ key, to, text });
					return null;
				},
			},
		],
		close: async () => {},
	};
}
`;

let host: Host | undefined;

/** Stops the host, and starts it again. */
async function restart(): Promise<void> {
	await host?.close();
	host = await startHost();
}

/** Asks the entry to deliver `text` to `to` once for `key`. It throws the error of the reply. */
async function deliver(key: string, to: string, text: string): Promise<void> {
	const socket = createConnection(statePaths(MAIN_PROJECT).socket);

	const reply = await new Promise<string>((resolve, reject) => {
		socket.once("error", reject);
		onLines(socket, resolve);
		socket.write(`${JSON.stringify({ type: "fixture.deliver", key, to, text })}\n`);
	}).finally(() => socket.destroy());

	const parsed: { ok: boolean; error?: string } = JSON.parse(reply);

	if (!parsed.ok) throw new Error(parsed.error);
}

/** Sends `message` to the child `handle` of `caller`, with no push of its answers. */
async function sendTo(caller: string, handle: string, message: string): Promise<void> {
	const send = {
		type: "send",
		requestId: `${caller}:${message}`,
		caller,
		handle,
		message,
		followUp: false,
		notify: false,
	} as const;

	await request(send, { start: false });
}

/** The conversation `id` of the host, through the handles of the entry. */
async function hostedConversation(id: string): Promise<Conversation> {
	if (shared.handles === undefined) throw new Error("the entry did not load");
	const found = await shared.handles.children.inspect(shared.handles.place, id, BACKGROUND_CONTEXT);

	if (found === undefined) throw new Error(`no conversation ${id}`);

	return found.conversation;
}

/** The ID of the newest entry of `conversation` that starts a context, a compaction or a reset. */
async function newestHead(conversation: Conversation): Promise<string | undefined> {
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	const marker = page.items.find((entry) => entry.head !== undefined);

	return marker === undefined ? undefined : String(marker.id);
}

/** Sends `message` to the project agent, and gives its conversation ID, which the input hook saw. */
async function agentConversation(message: string): Promise<string> {
	const client = await connect({ start: false });

	if (client === undefined) throw new Error("no host");

	try {
		await inputAgent(client, message);
	} finally {
		client.close();
	}

	await until(() => contexts.has(message));

	return shared.inputs.at(-1) ?? "";
}

/** Writes a new ask of the caller `pi-asker`, answers it as the user, and gives its ID. */
async function answeredAsk(title: string): Promise<number> {
	const written = await round("pi-asker", undefined, [{ title }]);
	const id = written.asks[0]?.id ?? 0;
	await answer([{ id, answer: "own", label: "Yes", words: ["yes"] }]);

	return id;
}

/** The keys of the events that the handler got for the ask `id`. */
function keysOf(id: number): string[] {
	return shared.events.filter((event) => event.ask.id === id).map((event) => event.key);
}

beforeAll(async () => {
	await setUp();
	// A compaction keeps no recent message, so the short transcript of a child has one to make.
	await setSettings({ compaction: { keepRecentTokens: 0 } });
	const module = join(root, "hooks-entry.mjs");
	await writeFile(module, HOOKS_ENTRY);
	setEntry("hooks", module);
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("the input hook of an entry", { timeout: 30_000 }, () => {
	it("writes its entry before the prompt of a spawn, of a send to a child, and of an input to the agent", async () => {
		const child = await spawnAs("pi-hooks", "Hooked spawn", { notify: false });
		await until(() => contexts.has("Hooked spawn"));
		const conversation = shared.inputs.at(-1);
		expect(contexts.get("Hooked spawn")?.slice(-2)).toEqual([`Hook for ${conversation}`, "Hooked spawn"]);

		const send = {
			type: "send",
			requestId: "pi-hooks:send",
			caller: "pi-hooks",
			handle: child.handle,
			message: "Hooked send",
			followUp: false,
			notify: false,
		} as const;

		await request(send, { start: false });
		await until(() => contexts.has("Hooked send"));
		expect(shared.inputs.at(-1)).toBe(conversation);
		expect(contexts.get("Hooked send")?.slice(-2)).toEqual([`Hook for ${conversation}`, "Hooked send"]);

		const agent = await agentConversation("Hooked input");
		expect(agent).not.toBe(conversation);
		expect(contexts.get("Hooked input")?.slice(-2)).toEqual([`Hook for ${agent}`, "Hooked input"]);
	});

	it("gets the newest head after a compaction and a reset, and writes at most one entry", async () => {
		const child = await spawnAs("pi-heads", "Heads spawn", { notify: false });
		await until(() => called("Heads spawn") === 1);
		const id = shared.inputs.at(-1) ?? "";
		expect(shared.heads.at(-1)).toBeUndefined();
		const conversation = await hostedConversation(id);

		await conversation.compact(undefined, BACKGROUND_CONTEXT);

		const compacted = await vi.waitFor(
			async () => (await newestHead(conversation)) ?? Promise.reject(new Error("no head")),
		);

		await sendTo("pi-heads", child.handle, "After the compaction");
		await until(() => called("After the compaction") === 1);
		expect(shared.heads.at(-1)).toBe(compacted);

		await conversation.reset(undefined, BACKGROUND_CONTEXT);

		const reset = await vi.waitFor(async () => {
			const head = await newestHead(conversation);

			return head !== undefined && head !== compacted ? head : Promise.reject(new Error("no new head"));
		});

		await sendTo("pi-heads", child.handle, "After the reset");
		await until(() => called("After the reset") === 1);
		expect(shared.heads.at(-1)).toBe(reset);

		shared.twice = true;

		try {
			await sendTo("pi-heads", child.handle, "Write twice");
			await until(() => called("Write twice") === 1);
		} finally {
			shared.twice = false;
		}

		expect(contexts.get("Write twice")?.slice(-2)).toEqual([`Hook for ${id}`, "Write twice"]);
	});
});

describe("the answered asks", { timeout: 30_000 }, () => {
	it("go to the handler with their key, and an event whose handler hangs comes again after a restart", async () => {
		const hung = Promise.withResolvers<void>();
		shared.handle = () => hung.promise;
		const id = await answeredAsk("Hang?");
		await until(() => keysOf(id).length === 1);
		expect(shared.events.at(-1)).toEqual({ key: expect.stringMatching(/^answer:\d+$/), ask: expect.anything() });
		expect(shared.events.at(-1)?.ask).toMatchObject({ id, state: "answered", answer: "own", words: ["yes"] });

		shared.handle = async () => {};

		await restart();
		await until(() => keysOf(id).length === 2);
		const [key, again] = keysOf(id);
		expect(again).toBe(key);
	});

	it("skip an event whose handler throws until the next start", async () => {
		shared.handle = async () => {
			throw new Error("Handler failed");
		};

		const failed = await answeredAsk("Fail?");
		await until(() => keysOf(failed).length === 1);

		shared.handle = async () => {};

		const later = await answeredAsk("Later?");
		await until(() => keysOf(later).length === 1);
		expect(keysOf(failed)).toHaveLength(1);

		await restart();
		await until(() => keysOf(failed).length === 2);
		expect(keysOf(later)).toHaveLength(1);
	});
});

describe("the deliveries of an entry", { timeout: 30_000 }, () => {
	it("refuse a delivery before the host opens, and to a conversation that the host does not have", async () => {
		expect(shared.beforeOpen).toBe("The host is not open yet");
		await expect(deliver("unknown", "999999", "Nowhere")).rejects.toThrow(
			"999999 is not a conversation or a Pi session of the host",
		);
	});

	it("go once for each key to a child and to the agent, after their input hooks, also after a restart", async () => {
		await spawnAs("pi-deliver", "Delivery child", { notify: false });
		await until(() => called("Delivery child") === 1);
		const child = shared.inputs.at(-1) ?? "";
		const agent = await agentConversation("Find the agent");

		for (const to of [child, agent]) {
			await deliver("once", to, `Delivered to ${to}`);
			await deliver("once", to, `Delivered to ${to}`);
			await until(() => called(`Delivered to ${to}`) === 1);
			expect(contexts.get(`Delivered to ${to}`)?.slice(-2)).toEqual([`Hook for ${to}`, `Delivered to ${to}`]);
		}

		await restart();

		for (const to of [child, agent]) {
			await deliver("once", to, `Delivered to ${to}`);
			// The push sends the deliveries of a conversation in order, so the next one comes after the repeat.
			await deliver("after", to, `After ${to}`);
			await until(() => called(`After ${to}`) === 1);
			expect(called(`Delivered to ${to}`)).toBe(1);
		}
	});

	it("go once for each key to a Pi session, in the reply of its answers request, also after a restart", async () => {
		const session = "pi-entry-session";

		const first = await answersOf(session, async () => {
			await deliver("once", session, "To the session");
			await deliver("once", session, "To the session");
		});

		expect(first).toEqual([{ source: "entry", key: "once", text: "To the session" }]);

		const second = await answersOf(session, async () => {
			await deliver("once", session, "To the session");
			await deliver("after", session, "After the session");
		});

		expect(second).toEqual([{ source: "entry", key: "after", text: "After the session" }]);
		await restart();

		const third = await answersOf(session, async () => {
			await deliver("once", session, "To the session");
			await deliver("later", session, "Later to the session");
		});

		expect(third).toEqual([{ source: "entry", key: "later", text: "Later to the session" }]);
	});
});

/**
 * Opens an `answers` request of the Pi session `caller`, runs `deliver` once the host knows the session, and gives the
 * reply.
 */
async function answersOf(caller: string, deliver: () => Promise<void>): Promise<readonly Delivery[]> {
	const client = await connect({ start: false });

	if (client === undefined) throw new Error("no host");

	try {
		const pending = client.request({ type: "answers", caller });
		// The host knows the session once it opened its request, so the first delivery can fail.
		await vi.waitFor(deliver, { timeout: 10_000 });

		return await pending;
	} finally {
		client.close();
	}
}
