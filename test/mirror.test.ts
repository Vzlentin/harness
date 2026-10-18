import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as coding from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import { Container, Spacer, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChatKit, ChatView } from "../src/chat.ts";
import type { Host } from "../src/host.ts";
import { Mirror } from "../src/mirror.ts";
import { addProject } from "../src/projects.ts";
import { AGENT_HANDLE } from "../src/protocol.ts";
import { inboxOf } from "../src/view-state.ts";
import {
	called,
	cli,
	FakeTerminal,
	gates,
	handleOf,
	root,
	setUp,
	startHost,
	tearDown,
	textOf,
	until,
} from "./helpers.ts";

/** The chat draws with the Pi modules of this package, as a Pi that loads the extension gives its own. */
const KIT: ChatKit = { coding, tui: { Container, Spacer, Text }, color: (_name, text) => text };

/** The text of each user and assistant message in `view`. */
function textsOf(view: ConversationView): string[] {
	return view.entries.flatMap((entry) => {
		const message = entry.model?.[0];

		return message !== undefined && (message.role === "user" || message.role === "assistant") ? [textOf(message)] : [];
	});
}

let host: Host | undefined;

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
		const mirror = await Mirror.open({ project: "main", handle: AGENT_HANDLE }, () => changes++);

		try {
			expect(mirror.child).toMatchObject({ handle: AGENT_HANDLE, name: "main agent", state: "idle" });
			await mirror.send("Mirror hello", false);
			await until(() => textsOf(mirror.view).includes("Answer to Mirror hello"));
			expect(textsOf(mirror.view).slice(-2)).toEqual(["Mirror hello", "Answer to Mirror hello"]);
			await until(() => mirror.child.state === "idle");
			expect(changes).toBeGreaterThan(0);
		} finally {
			mirror.close();
		}
	});

	it("queues messages while the agent works, and an abort gives them back, steers first", async () => {
		const mirror = await Mirror.open({ project: "main", handle: AGENT_HANDLE }, () => {});

		try {
			gates.set("Mirror long turn", Promise.withResolvers());
			await mirror.send("Mirror long turn", false);
			await until(() => called("Mirror long turn") === 1 && mirror.busy);
			await mirror.send("Mirror later", true);
			await mirror.send("Mirror steer", false);
			await until(() => inboxOf(mirror.view).items.length === 2);
			expect(await mirror.abort()).toEqual(["Mirror steer", "Mirror later"]);
			await until(() => mirror.child.state === "idle" && inboxOf(mirror.view).items.length === 0);
			expect(called("Mirror steer")).toBe(0);
			expect(called("Mirror later")).toBe(0);
		} finally {
			mirror.close();
		}
	});

	it("changes the model and the thinking level of the agent", async () => {
		const mirror = await Mirror.open({ project: "main", handle: AGENT_HANDLE }, () => {});

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
			const mirror = await Mirror.open({ project: "web", handle: AGENT_HANDLE }, () => {});

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

		await expect(Mirror.open({ project: "nope", handle: AGENT_HANDLE }, () => {})).rejects.toThrow(
			"Unknown harness project: nope",
		);
	});

	it("draws the transcript of a child with Pi's message and tool components", async () => {
		coding.initTheme();
		const cwd = await mkdtemp(join(root, "drawn-"));
		const handle = handleOf(await cli(["spawn", "--cwd", cwd, "--prompt", "Use a tool"]));
		const mirror = await Mirror.open({ project: "main", handle }, () => {});
		const chat = new ChatView(KIT, new TuiMainScreen(new FakeTerminal()), cwd);

		const drawn = () => {
			chat.apply(mirror.view);

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

	it("ends as closed when the host closes", async () => {
		const mirror = await Mirror.open({ project: "main", handle: AGENT_HANDLE }, () => {});
		await host?.close();
		expect(await mirror.ended).toBe("closed");
	});
});
