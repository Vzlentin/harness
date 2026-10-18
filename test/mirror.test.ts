import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as coding from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatView } from "../pi/chat.ts";
import { ModelSync, type PiModels, type PiSession } from "../pi/model-sync.ts";
import type { Host } from "../src/host.ts";
import { Mirror, type MirrorConfigure, type MirrorOptions, type MirrorTarget } from "../src/mirror.ts";
import { addProject } from "../src/projects.ts";
import { AGENT_HANDLE, errorMessage } from "../src/protocol.ts";
import { inboxOf } from "../src/view-state.ts";
import {
	called,
	cli,
	FakeTerminal,
	gates,
	handleOf,
	models,
	root,
	setUp,
	startHost,
	tearDown,
	textOf,
	until,
} from "./helpers.ts";

const AGENT: MirrorTarget = { project: "main", handle: AGENT_HANDLE };

const HOST_CLOSED = "The harness host closed the connection";

/** The text of each user and assistant message in `view`. */
function textsOf(view: ConversationView | undefined): string[] {
	return (view?.entries ?? []).flatMap((entry) => {
		const message = entry.model?.[0];

		return message !== undefined && (message.role === "user" || message.role === "assistant") ? [textOf(message)] : [];
	});
}

/** The number of messages in the inbox of the conversation of `mirror`. */
function inboxSize(mirror: Mirror): number {
	return mirror.view === undefined ? 0 : inboxOf(mirror.view).items.length;
}

/**
 * A mirror of `target`, connected. It starts no host, so it connects only to the hosts of the tests, which have the
 * faux provider.
 */
async function opened(target: MirrorTarget, options: MirrorOptions = {}): Promise<Mirror> {
	const mirror = new Mirror(target, () => {}, { start: false, ...options });
	await until(() => mirror.status.kind !== "connecting");

	if (mirror.status.kind === "failed") throw new Error(mirror.status.reason);

	return mirror;
}

type ThinkingLevel = ReturnType<PiModels["getThinkingLevel"]>;

/** The model and the thinking level of a Pi session. Like Pi, it takes its own level when it takes a model. */
class FakePi implements PiModels, PiSession {
	model: Model<Api> | undefined;
	thinking: ThinkingLevel = "off";
	readonly modelRegistry = { find: (provider: string, id: string) => models.getModel(provider, id) };

	async setModel(model: Model<Api>): Promise<boolean> {
		// Pi checks the model's login before it takes the model.
		await new Promise((resolve) => setTimeout(resolve, 10));
		this.model = model;
		this.thinking = "xhigh";

		return true;
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinking;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.thinking = level;
	}
}

/** The model `faux/<id>` of the test host. */
function fauxModel(id: string): Model<Api> {
	const model = models.getModel("faux", id);

	if (model === undefined) throw new Error(`no model faux/${id}`);

	return model;
}

let host: Host | undefined;

/** Closes the host of `main`. A test that does it starts the host again before it ends. */
async function closeHost(): Promise<void> {
	await host?.close();
	host = undefined;
}

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("mirror", { timeout: 30_000 }, () => {
	it("shows the project agent and its answer to a message", async () => {
		let changes = 0;
		const mirror = new Mirror(AGENT, () => changes++, { start: false });

		try {
			await until(() => mirror.status.kind === "open");
			expect(mirror.child).toMatchObject({ handle: AGENT_HANDLE, name: "main agent", state: "idle" });
			await mirror.send("Mirror hello", false);
			await until(() => textsOf(mirror.view).includes("Answer to Mirror hello"));
			expect(textsOf(mirror.view).slice(-2)).toEqual(["Mirror hello", "Answer to Mirror hello"]);
			await until(() => mirror.child?.state === "idle");
			expect(changes).toBeGreaterThan(0);
		} finally {
			mirror.close();
		}
	});

	it("queues messages while the agent works, and an abort gives them back, steers first", async () => {
		const mirror = await opened(AGENT);

		try {
			gates.set("Mirror long turn", Promise.withResolvers());
			await mirror.send("Mirror long turn", false);
			await until(() => called("Mirror long turn") === 1 && mirror.busy);
			await mirror.send("Mirror later", true);
			await mirror.send("Mirror steer", false);
			await until(() => inboxSize(mirror) === 2);
			expect(await mirror.abort()).toEqual(["Mirror steer", "Mirror later"]);
			await until(() => mirror.child?.state === "idle" && inboxSize(mirror) === 0);
			expect(called("Mirror steer")).toBe(0);
			expect(called("Mirror later")).toBe(0);
		} finally {
			mirror.close();
		}
	});

	it("changes the model and the thinking level of the agent", async () => {
		const mirror = await opened(AGENT);

		try {
			await mirror.configure({ thinking: "high" });
			expect(mirror.child).toMatchObject({ provider: "faux", model: "faux-1", thinking: "high" });
			await mirror.configure({ provider: "faux", model: "faux-2" });
			expect(mirror.child).toMatchObject({ provider: "faux", model: "faux-2", thinking: "high" });
			await expect(mirror.configure({ thinking: "xhigh" })).rejects.toThrow("faux/faux-2 has no thinking level xhigh");
			await mirror.configure({ provider: "faux", model: "faux-1", thinking: "medium" });
		} finally {
			mirror.close();
		}
	});

	it("watches the agent in the host of the project of its target", async () => {
		const dir = realpathSync(await mkdtemp(join(root, "web-")));
		addProject("web", dir);
		const web = await startHost("web");

		try {
			const mirror = await opened({ project: "web", handle: AGENT_HANDLE });

			try {
				expect(mirror.child).toMatchObject({ name: "web agent", cwd: dir });
				await mirror.send("Web hello", false);
				await until(() => textsOf(mirror.view).includes("Answer to Web hello"));
			} finally {
				mirror.close();
			}
		} finally {
			await web?.close();
		}
	});

	it("fails at once for an unknown project or child", async () => {
		const project = new Mirror({ project: "nope", handle: AGENT_HANDLE }, () => {}, { start: false });
		const child = new Mirror({ project: "main", handle: "abcdef" }, () => {}, { start: false });
		await until(() => project.status.kind === "failed" && child.status.kind === "failed");
		expect(project.status).toEqual({ kind: "failed", reason: "Unknown harness project: nope" });
		expect(child.status).toEqual({ kind: "failed", reason: "Unknown subagent: abcdef" });
		await expect(child.send("Too late", false)).rejects.toThrow("Unknown subagent: abcdef");
	});

	it("fails when the child is stopped", async () => {
		const handle = handleOf(await cli(["spawn", "--name", "doomed", "--prompt", "Doomed"]));
		await cli(["wait", handle]);
		const mirror = await opened({ project: "main", handle });

		try {
			expect((await cli(["stop", handle])).code).toBe(0);
			await until(() => mirror.status.kind === "failed");
			expect(mirror.status).toEqual({ kind: "failed", reason: `doomed (${handle}) was stopped` });
		} finally {
			mirror.close();
		}
	});

	it("connects again when the host restarts, and then sends the message that waited, once", async () => {
		const mirror = await opened(AGENT, { retryDelaysMs: [0, 500, 2000] });

		try {
			await closeHost();
			await until(() => mirror.status.kind === "reconnecting");
			// The send waits for the connection, so the host starts while it waits.
			[host] = await Promise.all([startHost(), mirror.send("After restart", false)]);
			expect(mirror.status.kind).toBe("open");
			await until(() => textsOf(mirror.view).includes("Answer to After restart"));
			expect(called("After restart")).toBe(1);
		} finally {
			mirror.close();
			host ??= await startHost();
		}
	});

	it("fails when the host closes a connection that it opened again less than 10 s before", async () => {
		const mirror = await opened(AGENT, { retryDelaysMs: [0, 500, 2000] });

		try {
			await closeHost();
			await until(() => mirror.status.kind === "reconnecting");
			host = await startHost();
			await until(() => mirror.status.kind === "open");
			await closeHost();
			await until(() => mirror.status.kind === "failed");
			expect(mirror.status).toEqual({ kind: "failed", reason: `${HOST_CLOSED}. Run /reload to attach again` });
		} finally {
			mirror.close();
			host ??= await startHost();
		}
	});

	it("fails when all the tries to connect again fail, and rejects the messages that waited", async () => {
		const mirror = await opened(AGENT, { retryDelaysMs: [0, 300] });
		const reason = `${HOST_CLOSED}. Connecting again failed: Could not connect to the harness host`;

		try {
			await closeHost();
			await until(() => mirror.status.kind === "reconnecting");
			await expect(mirror.send("Never sent", false)).rejects.toThrow(reason);
			expect(mirror.status).toEqual({ kind: "failed", reason });
			await expect(mirror.send("After the failure", false)).rejects.toThrow(reason);
		} finally {
			mirror.close();
			host ??= await startHost();
		}

		expect(called("Never sent")).toBe(0);
	});

	it("draws the transcript of a child with Pi's message and tool components", async () => {
		coding.initTheme();
		const cwd = await mkdtemp(join(root, "drawn-"));
		const handle = handleOf(await cli(["spawn", "--cwd", cwd, "--prompt", "Use a tool"]));
		const mirror = await opened({ project: "main", handle });
		const chat = new ChatView(new TuiMainScreen(new FakeTerminal()), cwd, (_name, text) => text);

		const drawn = () => {
			if (mirror.view !== undefined) chat.apply(mirror.view);

			return stripVTControlCharacters(chat.transcript.render(100).join("\n"));
		};

		try {
			await until(() => drawn().includes("$ while [ ! -f go ]; do sleep 0.05; done"));
			expect(drawn()).toContain("Use a tool");
			await writeFile(join(cwd, "go"), "");
			await until(() => drawn().includes("Tool said:"));
			expect(drawn().indexOf("$ while")).toBeLessThan(drawn().indexOf("Tool said:"));
		} finally {
			chat.stopTimers();
			mirror.close();
		}
	});
});

describe("model sync", { timeout: 30_000 }, () => {
	it("gives Pi the agent's model, then the agent's level and not the level that Pi takes with the model", async () => {
		const mirror = await opened(AGENT);
		const pi = new FakePi();
		const sync = new ModelSync(pi, pi, mirror, () => {});

		try {
			await mirror.configure({ provider: "faux", model: "faux-2", thinking: "low" });
			const child = mirror.child;

			if (child === undefined) throw new Error("no agent");
			sync.fromAgent(child);
			await until(() => pi.model?.id === "faux-2" && pi.thinking === "low");
		} finally {
			sync.close();
			await mirror.configure({ provider: "faux", model: "faux-1", thinking: "medium" });
			mirror.close();
		}
	});

	it("asks the host for the model that the user selects in Pi, and Pi goes back when the host refuses it", async () => {
		const mirror = await opened(AGENT);
		const pi = new FakePi();
		const errors: string[] = [];
		const sync = new ModelSync(pi, pi, mirror, (cause) => errors.push(errorMessage(cause)));

		try {
			sync.piSelected("faux", "faux-2");
			await until(() => mirror.child?.model === "faux-2");
			// Pi has the model that the user selected before it tells the extension.
			pi.model = { ...fauxModel("faux-2"), id: "missing" };
			sync.piSelected("faux", "missing");
			await until(() => errors.length === 1 && pi.model?.id === "faux-2");
			expect(mirror.child?.model).toBe("faux-2");
		} finally {
			sync.close();
			await mirror.configure({ provider: "faux", model: "faux-1", thinking: "medium" });
			mirror.close();
		}
	});

	it("asks the host for a cycled level once Pi has the agent's model, and Pi goes back when the host refuses it", async () => {
		const mirror = await opened(AGENT);
		const configure = vi.fn((change: MirrorConfigure) => mirror.configure(change));

		const agent = {
			get child() {
				return mirror.child;
			},
			configure,
		};

		const pi = new FakePi();
		const errors: string[] = [];
		const sync = new ModelSync(pi, pi, agent, (cause) => errors.push(errorMessage(cause)));

		try {
			pi.thinking = "high";
			sync.piCycled();
			expect(configure).not.toHaveBeenCalled();
			pi.model = fauxModel("faux-1");
			sync.piCycled();
			await until(() => mirror.child?.thinking === "high");
			await mirror.configure({ provider: "faux", model: "faux-2" });
			pi.model = fauxModel("faux-2");
			// faux-2 has no level xhigh.
			pi.thinking = "xhigh";
			sync.piCycled();
			await until(() => errors.length === 1 && pi.thinking === "high");
			expect(mirror.child?.thinking).toBe("high");
		} finally {
			sync.close();
			await mirror.configure({ provider: "faux", model: "faux-1", thinking: "medium" });
			mirror.close();
		}
	});
});
