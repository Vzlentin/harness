import { once } from "node:events";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConversationView } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, connect, request } from "../src/client/client.ts";
import { openChildTab, openConversationPane } from "../src/client/herdr.ts";
import type { Host } from "../src/host/run.ts";
import { statePaths } from "../src/protocol/paths.ts";
import type { ChildInfo, WatchLine } from "../src/protocol/requests.ts";
import { applyChange } from "../src/protocol/view-change.ts";
import {
	CLI,
	called,
	cli,
	fakePi,
	gates,
	handleOf,
	logLines,
	root,
	setUp,
	startHost,
	tearDown,
	textOf,
	until,
} from "./helpers.ts";

/** The text of each user and assistant message in `view`. */
function textsOf(view: ConversationView | undefined): string[] {
	return (view?.entries ?? []).flatMap((entry) => {
		const message = entry.model?.[0];

		return message !== undefined && (message.role === "user" || message.role === "assistant") ? [textOf(message)] : [];
	});
}

/** Pushes each event of `lines` to `into`, until the connection closes. */
async function collect(lines: AsyncIterable<WatchLine>, into: WatchLine[]): Promise<void> {
	for await (const line of lines) into.push(line);
}

/** A client of the running host. */
async function hostClient(): Promise<Client> {
	const client = await connect({ start: false });

	if (client === undefined) throw new Error("no host");

	return client;
}

/** The output of `hc get --json t3` for the terminal `t3` of the caller, in the space `s1` and the tab `b2`. */
const CALLER = JSON.stringify({ address: "t3", labels: { "herdr.space": "s1", "herdr.tab": "b2" } });

/**
 * An `hc` on `PATH` that logs its arguments to `log`, one line for each call, and prints `terminal` for `get`. Its
 * environment is that of the hc terminal `t3`. With `fail`, each call whose first word is `failOn` writes `fail` to
 * stderr and exits with 1, after the log line.
 */
async function fakeHc(
	terminal = CALLER,
	fail?: string,
	failOn = "run",
): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const bin = await mkdtemp(join(root, "bin-"));
	const log = join(bin, "hc.log");

	const script = `#!/bin/sh
echo "$*" >> "${log}"
${fail === undefined ? "" : `if [ "$1" = "${failOn}" ]; then echo '${fail}' >&2; exit 1; fi`}
if [ "$1" = "get" ]; then echo '${terminal}'; fi
`;

	await writeFile(join(bin, "hc"), script);
	await chmod(join(bin, "hc"), 0o755);

	return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HC_TERMINAL_ID: "t3" }, log };
}

/** A child named `name`, in `root`, as the host lists it. */
function childInfo(name: string): ChildInfo {
	return { handle: "abc123", name, state: "idle", provider: "p", model: "m", thinking: "off", cwd: root };
}

/** `env` without `XDG_STATE_HOME` and `XDG_CONFIG_HOME`. */
function withoutXdg(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const rest = { ...env };
	delete rest.XDG_STATE_HOME;
	delete rest.XDG_CONFIG_HOME;

	return rest;
}

/** A children library conversation, as the host lists it, in `root`. */
function conversationInfo(): ChildInfo {
	return {
		handle: "c1",
		conversation: "c1",
		name: "key",
		state: "idle",
		provider: "p",
		model: "m",
		thinking: "off",
		cwd: root,
	};
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

describe("subagent", { timeout: 30_000 }, () => {
	it("watches a child: a snapshot, then the change of each commit, which rebuilds the view", async () => {
		gates.set("Task:\nWatched", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--name", "watched", "--prompt", "Watched"]));
		await until(() => called("Task:\nWatched") === 1);
		const client = await hostClient();
		const first = await client.watch({ kind: "child", handle });
		const lines: WatchLine[] = [];
		void collect(first.lines, lines);

		// The view of the first watch after the changes of all the lines so far.
		const rebuilt = () =>
			lines.reduce((view, line) => (line.stopped ? view : applyChange(view, line.change)), first.view);

		try {
			expect(first.child).toMatchObject({ handle, name: "watched", state: "busy", cwd: realpathSync(root) });
			expect(textsOf(first.view)).toEqual(["Task:\nWatched"]);
			gates.get("Task:\nWatched")?.resolve();
			await until(() => lines.some((line) => !line.stopped && line.child.state === "idle"));
			expect(textsOf(rebuilt())).toEqual(["Task:\nWatched", "Answer to Task:\nWatched"]);

			const second = await connect({ start: false });

			try {
				const fresh = await second?.request({ type: "watch", handle });
				expect(fresh?.child.state).toBe("idle");
				expect(textsOf(fresh?.view)).toEqual(["Task:\nWatched", "Answer to Task:\nWatched"]);
				// The changes rebuild the whole view of a new watch: the entries, the documents and the conversation.
				await until(() => isDeepStrictEqual(rebuilt(), fresh?.view));
			} finally {
				second?.close();
			}
		} finally {
			client.close();
		}
	});

	it("sends a watch line when the child is renamed", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Rename me"]));
		await cli(["wait", handle]);
		const client = await hostClient();
		const watched = await client.watch({ kind: "child", handle });
		const lines: WatchLine[] = [];
		void collect(watched.lines, lines);

		try {
			expect(watched.child.state).toBe("idle");
			expect((await cli(["rename", handle, "renamed"])).code).toBe(0);
			await until(() => lines.some((line) => !line.stopped && line.child.name === "renamed"));
		} finally {
			client.close();
		}
	});

	it("keeps the name and the state of a renamed child on its watch lines", async () => {
		gates.set("Task:\nFail", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Fail"]));
		await until(() => called("Task:\nFail") === 1);
		const client = await hostClient();
		const watched = await client.watch({ kind: "child", handle });
		const lines: WatchLine[] = [];
		void collect(watched.lines, lines);

		try {
			expect(watched.child.state).toBe("busy");
			expect((await cli(["rename", handle, "busy name"])).code).toBe(0);
			await until(() => lines.some((line) => !line.stopped && line.child.name === "busy name"));
			expect(lines.find((line) => !line.stopped && line.child.name === "busy name")).toMatchObject({
				child: { state: "busy" },
			});
			gates.get("Task:\nFail")?.resolve();
			await until(() =>
				lines.some((line) => !line.stopped && line.child.state === "error" && line.child.name === "busy name"),
			);
			expect((await client.request({ type: "status", handle })).state).toBe("error");
		} finally {
			client.close();
		}
	});

	it("keeps watching after a watch connection closes during setup", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Closed watch"]));
		await cli(["wait", handle]);
		const stderr = vi.spyOn(process.stderr, "write");

		try {
			const socket = createConnection(statePaths("main").socket);
			socket.write(`${JSON.stringify({ type: "watch", handle })}\n`, () => socket.destroy());
			await once(socket, "close");
			const client = await hostClient();
			const watched = await client.watch({ kind: "child", handle });
			const lines: WatchLine[] = [];
			void collect(watched.lines, lines);

			try {
				expect((await cli(["rename", handle, "renamed after close"])).code).toBe(0);
				await until(() => lines.some((line) => !line.stopped && line.child.name === "renamed after close"));
			} finally {
				client.close();
			}

			expect(stderr.mock.calls.filter(([text]) => String(text).includes("warning:"))).toEqual([]);
		} finally {
			stderr.mockRestore();
		}
	});

	it("answers requests on a watch connection, between the watch events", async () => {
		const handle = handleOf(await cli(["spawn", "--prompt", "Idle"]));
		await cli(["wait", handle]);
		const client = await hostClient();

		try {
			const watched = await client.watch({ kind: "child", handle });
			expect(watched.child.state).toBe("idle");
			const lines: WatchLine[] = [];
			void collect(watched.lines, lines);

			const sent = await client.request({
				type: "input",
				requestId: "watch-connection-send",
				handle,
				message: "On the watch connection",
				followUp: false,
			});

			expect(sent.verb).toBe("Prompted");
			const busy = () => lines.findIndex((line) => !line.stopped && line.child.state === "busy");
			await until(() => busy() !== -1);
			await until(() => lines.slice(busy() + 1).some((line) => !line.stopped && line.child.state === "idle"));
			expect((await client.request({ type: "status", handle })).state).toBe("idle");
		} finally {
			client.close();
		}
	});

	it("aborts a busy child, which keeps its history and answers later", async () => {
		gates.set("Task:\nAbort me", Promise.withResolvers());
		const handle = handleOf(await cli(["spawn", "--prompt", "Abort me"]));
		await until(() => called("Task:\nAbort me") === 1);
		const client = await connect({ start: false });

		if (client === undefined) throw new Error("no host");

		try {
			expect((await client.request({ type: "abort", handle })).state).toBe("idle");
			expect(await client.request({ type: "abort", handle })).toMatchObject({ handle, state: "idle" });
			expect((await cli(["status", handle])).stdout).toBe(`${handle}: idle (faux/faux-1, medium)\n`);
			expect((await cli(["wait", handle])).stderr).toBe(`${handle} was aborted\n`);
			expect((await cli(["send", handle, "After abort"])).stdout).toBe(`Prompted ${handle}\n`);
			expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to After abort\n`);
			const watched = await client.request({ type: "watch", handle });
			expect(textsOf(watched.view)).toContain("Task:\nAbort me");
			expect(textsOf(watched.view)).toContain("Answer to After abort");
		} finally {
			client.close();
		}
	});

	it("opens a child and the project agent in Pi, and refuses an unknown child before Pi starts", async () => {
		const pi = await fakePi();
		const handle = handleOf(await cli(["spawn", "--name", "piped", "--prompt", "Pipe me"]));

		expect(await cli(["attach", handle], pi.env)).toMatchObject({ code: 3, stderr: "" });
		expect(logLines(pi.log)).toEqual([`--harness main --harness-child ${handle} HARNESS_PROJECT=`]);

		expect((await cli(["main"], pi.env)).code).toBe(3);
		expect(logLines(pi.log)[1]).toBe("--harness main HARNESS_PROJECT=");

		expect(await cli(["attach", "abcdef"], pi.env)).toMatchObject({ code: 1, stderr: "Unknown subagent: abcdef\n" });
		expect(logLines(pi.log)).toHaveLength(2);

		const bin = await mkdtemp(join(root, "empty-"));
		expect(await cli(["main"], { PATH: bin })).toMatchObject({
			code: 1,
			stderr: "pi is not on PATH. Install Pi to open the agent\n",
		});
	});

	it("opens Pi without the node_modules/.bin folders on PATH, whose pi comes from pi-coding-agent", async () => {
		const pi = await fakePi();
		const bin = join(await mkdtemp(join(root, "npm-")), "node_modules", ".bin");
		const decoyLog = join(bin, "pi.log");
		await mkdir(bin, { recursive: true });
		await writeFile(join(bin, "pi"), `#!/bin/sh\necho decoy >> "${decoyLog}"\nexit 3\n`);
		await chmod(join(bin, "pi"), 0o755);

		expect((await cli(["main"], { PATH: `${bin}:${pi.env.PATH}` })).code).toBe(3);
		expect(logLines(pi.log)).toHaveLength(1);
		expect(logLines(decoyLog)).toEqual([]);
	});

	it("opens a child in Pi in a new herdr-app tab, in the space of the hc terminal of the caller", async () => {
		const hc = await fakeHc();
		const handle = handleOf(await cli(["spawn", "--name", "tabbed", "--prompt", "Tab me"]));
		const children = (await request({ type: "list", caller: "cli" }, { start: false })) ?? [];
		const child = children.find((found) => found.handle === handle);

		if (child === undefined) throw new Error("no child");
		const state = hc.env.XDG_STATE_HOME;
		const config = hc.env.XDG_CONFIG_HOME;
		expect(state).toBeTruthy();
		expect(config).toBeTruthy();
		const run = `run --bg --keep --no-parent --cwd ${child.cwd} --name tabbed --label herdr.space=s1 --`;
		const command = `${process.execPath} ${CLI} --project main attach ${handle}`;
		await openChildTab(child, hc.env);
		expect(logLines(hc.log)).toEqual([
			"get --json t3",
			`${run} env XDG_STATE_HOME=${state} XDG_CONFIG_HOME=${config} ${command}`,
		]);
		// hc gives the program the environment of its server, so only `env` gives it the XDG variables of the caller.
		// Without them, the tab finds the host under HOME, as this process does.
		await openChildTab(child, withoutXdg(hc.env));
		expect(logLines(hc.log).slice(2)).toEqual(["get --json t3", `${run} ${command}`]);
	});

	it("names the hc terminal after the child, as hc takes a name, or leaves the name out", async () => {
		const hc = await fakeHc();

		// Each label of a child, and the name of its hc terminal.
		const names = {
			"Fix: Auth.Flow!": "fix--auth-flow-",
			"__Agent Ω 1234567890 1234567890 1234567890": "agent---1234567890-1234567890-12",
			t0: "t0",
			t7a: "t7a",
			T7: undefined,
			t7b: undefined,
			"!!!": undefined,
		};

		for (const name of Object.keys(names)) await openChildTab(childInfo(name), hc.env);
		const runs = logLines(hc.log).filter((line) => line.startsWith("run "));
		expect(runs.map((line) => /--name (\S+)/.exec(line)?.[1])).toEqual(Object.values(names));
	});

	it("opens a conversation in Pi in a new tab of a given space, without the labels of the caller", async () => {
		const hc = await fakeHc();
		const env = withoutXdg(hc.env);
		delete env.HC_TERMINAL_ID;
		await openConversationPane(conversationInfo(), { space: "s9" }, env);
		expect(logLines(hc.log)).toEqual([
			`run --bg --keep --no-parent --cwd ${root} --name key --label herdr.space=s9 -- ${process.execPath} ${CLI} --project main attach --conversation c1`,
		]);
	});

	it("opens a conversation in Pi in a new tab of the space of the caller, or to the right in its tab", async () => {
		const hc = await fakeHc();
		const env = withoutXdg(hc.env);
		const command = `${process.execPath} ${CLI} --project main attach --conversation c1`;
		const run = `run --bg --keep --no-parent --cwd ${root} --name key --label herdr.space=s1`;
		await openConversationPane(conversationInfo(), {}, env);
		await openConversationPane(conversationInfo(), { side: true }, env);
		expect(logLines(hc.log)).toEqual([
			"get --json t3",
			`${run} -- ${command}`,
			"get --json t3",
			`${run} --label herdr.tab=b2 -- ${command}`,
		]);
	});

	it("starts no hc terminal when the caller is not in one, or its terminal lacks a label", async () => {
		const outside = await fakeHc();
		const env = { ...outside.env };
		delete env.HC_TERMINAL_ID;
		const notInHc = "Not in an hc terminal: HC_TERMINAL_ID is not set";
		await expect(openChildTab(childInfo("outside"), env)).rejects.toThrow(notInHc);
		await expect(openConversationPane(conversationInfo(), { side: true }, env)).rejects.toThrow(notInHc);
		expect(logLines(outside.log)).toEqual([]);

		const noTab = await fakeHc(JSON.stringify({ address: "t3", labels: { "herdr.space": "s1" } }));
		await expect(openConversationPane(conversationInfo(), { side: true }, noTab.env)).rejects.toThrow(
			"The hc terminal t3 has no herdr.tab label",
		);
		expect(logLines(noTab.log)).toEqual(["get --json t3"]);

		const emptySpace = await fakeHc(JSON.stringify({ address: "t3", labels: { "herdr.space": "" } }));
		await expect(openChildTab(childInfo("empty"), emptySpace.env)).rejects.toThrow(
			"The hc terminal t3 has no herdr.space label",
		);
		expect(logLines(emptySpace.log)).toEqual(["get --json t3"]);

		const noLabels = await fakeHc('{"address":"t3"}');
		await expect(openChildTab(childInfo("unlabeled"), noLabels.env)).rejects.toThrow(
			'hc get gave no labels: {"address":"t3"}',
		);
		expect(logLines(noLabels.log)).toEqual(["get --json t3"]);
	});

	it("rejects with the error of hc when hc fails", async () => {
		const taken = '{"error":{"kind":"name_taken","message":"the name key is taken"}}';
		const hc = await fakeHc(CALLER, taken);
		await expect(openConversationPane(conversationInfo(), {}, hc.env)).rejects.toThrow(taken);
		expect(logLines(hc.log)).toHaveLength(2);

		const get = await fakeHc(CALLER, "no such terminal: t3", "get");
		await expect(openChildTab(childInfo("lost"), get.env)).rejects.toThrow("no such terminal: t3");
		expect(logLines(get.log)).toEqual(["get --json t3"]);
	});
});
