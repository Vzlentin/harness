import { once } from "node:events";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConversationView } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, connect, request } from "../src/client.ts";
import { agentReporter, openChildTab } from "../src/herdr.ts";
import type { Host } from "../src/host.ts";
import { AGENT_HANDLE, applyChange, statePaths, type WatchLine } from "../src/protocol.ts";
import { CLI, called, cli, gates, handleOf, root, setUp, startHost, tearDown, textOf, until } from "./helpers.ts";

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

/** The `--seq` of a logged `herdr` call. */
function seqOf(line: string | undefined): number {
	return Number(/--seq (\d+)/.exec(line ?? "")?.[1]);
}

/** A `pi` on `PATH` that logs its arguments and its Herdr variables to `log`, one line for each call, and exits with 3. */
async function fakePi(): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const bin = await mkdtemp(join(root, "bin-"));
	const log = join(bin, "pi.log");

	const script = `#!/bin/sh
echo "$* HERDR_ENV=$HERDR_ENV HARNESS_HERDR_PANE=$HARNESS_HERDR_PANE" >> "${log}"
exit 3
`;

	await writeFile(join(bin, "pi"), script);
	await chmod(join(bin, "pi"), 0o755);

	return { env: { PATH: `${bin}:${process.env.PATH}` }, log };
}

/**
 * A `herdr` on `PATH` that logs its arguments to `log`, one line for each call, and gives the pane `p1` to a new tab.
 * With `failTabCreate`, `tab create` writes that text to stderr and exits with 1.
 */
async function fakeHerdr(failTabCreate?: string): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const bin = await mkdtemp(join(root, "bin-"));
	const log = join(bin, "herdr.log");

	const tabCreate =
		failTabCreate === undefined
			? `echo '{"result":{"root_pane":{"pane_id":"p1"}}}'`
			: `echo '${failTabCreate}' >&2; exit 1`;

	const script = `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1 $2" = "tab create" ]; then ${tabCreate}; fi
`;

	await writeFile(join(bin, "herdr"), script);
	await chmod(join(bin, "herdr"), 0o755);

	return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log };
}

function logLines(log: string): string[] {
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
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
		const first = await client.watch(handle);
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
		const watched = await client.watch(handle);
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
		const watched = await client.watch(handle);
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
			const watched = await client.watch(handle);
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
			const watched = await client.watch(handle);
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

		// In Herdr, Pi gets the pane in HARNESS_HERDR_PANE and no HERDR_ENV, so Herdr's Pi integration does not report.
		const attached = await cli(["attach", handle], { ...pi.env, HERDR_ENV: "1", HERDR_PANE_ID: "pane-3" });
		expect(attached).toMatchObject({ code: 3, stderr: "" });
		expect(logLines(pi.log)).toEqual([`--harness main --harness-child ${handle} HERDR_ENV= HARNESS_HERDR_PANE=pane-3`]);

		expect((await cli(["main"], pi.env)).code).toBe(3);
		expect(logLines(pi.log)[1]).toBe("--harness main HERDR_ENV= HARNESS_HERDR_PANE=");

		expect(await cli(["attach", "abcdef"], pi.env)).toMatchObject({ code: 1, stderr: "Unknown subagent: abcdef\n" });
		expect(logLines(pi.log)).toHaveLength(2);

		const bin = await mkdtemp(join(root, "empty-"));
		expect(await cli(["main"], { PATH: bin })).toMatchObject({
			code: 1,
			stderr: "pi is not on PATH. Install Pi to open the agent\n",
		});
	});

	it("reports the state of a mirrored agent to the Herdr pane of a Pi that the CLI started", async () => {
		const herdr = await fakeHerdr();
		const reporter = agentReporter({ ...herdr.env, HARNESS_HERDR_PANE: "pane-7" }, "viewed", "abc123", "main");
		reporter.report(false);
		reporter.report(true);
		reporter.report(true);
		reporter.report(false);
		await reporter.release();

		const reports = logLines(herdr.log);

		const report = (state: string, index: number) =>
			`pane report-agent --source custom:harness --agent viewed --state ${state} --seq ${seqOf(reports[index])} pane-7 -- env ${process.execPath} ${CLI} --project main attach abc123`;

		expect(reports).toEqual([
			report("idle", 0),
			report("working", 1),
			report("idle", 2),
			`pane release-agent --source custom:harness --agent viewed --seq ${seqOf(reports[3])} pane-7`,
		]);
		const seqs = reports.map(seqOf);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);

		// The project agent resumes with `harness <project>`.
		const agent = agentReporter({ ...herdr.env, HARNESS_HERDR_PANE: "pane-9" }, "main agent", AGENT_HANDLE, "main");
		agent.report(false);
		await agent.release();
		expect(logLines(herdr.log)[4]).toBe(
			`pane report-agent --source custom:harness --agent main agent --state idle --seq ${seqOf(logLines(herdr.log)[4])} pane-9 -- env ${process.execPath} ${CLI} main`,
		);

		// A Pi that the user started in Herdr has HERDR_ENV and no HARNESS_HERDR_PANE: Herdr's Pi integration reports there.
		const silent = agentReporter({ ...herdr.env, HERDR_ENV: "1", HERDR_PANE_ID: "pane-8" }, "x", "abc123", "main");
		silent.report(true);
		await silent.release();
		expect(logLines(herdr.log)).toHaveLength(6);
	});

	it("opens a child in Pi in a Herdr tab", async () => {
		const herdr = await fakeHerdr();
		const handle = handleOf(await cli(["spawn", "--name", "tabbed", "--prompt", "Tab me"]));
		const children = (await request({ type: "list", caller: "cli" }, { start: false })) ?? [];
		const child = children.find((found) => found.handle === handle);

		if (child === undefined) throw new Error("no child");
		const state = herdr.env.XDG_STATE_HOME;
		const config = herdr.env.XDG_CONFIG_HOME;
		expect(state).toBeTruthy();
		expect(config).toBeTruthy();
		const run = `pane run p1 'env' '${process.execPath}' '${CLI}' '--project' 'main' 'attach' '${handle}'`;
		await openChildTab(child, herdr.env);
		expect(logLines(herdr.log)).toEqual([
			`tab create --cwd ${child.cwd} --label tabbed --focus --env XDG_STATE_HOME=${state} --env XDG_CONFIG_HOME=${config}`,
			run,
		]);
		// Without XDG_STATE_HOME and XDG_CONFIG_HOME, the tab finds the host under HOME, as this process does.
		const env = { ...herdr.env };
		delete env.XDG_STATE_HOME;
		delete env.XDG_CONFIG_HOME;
		await openChildTab(child, env);
		expect(logLines(herdr.log).slice(2)).toEqual([`tab create --cwd ${child.cwd} --label tabbed --focus`, run]);
	});

	it("rejects with the herdr error when it cannot open a Herdr tab", async () => {
		const herdr = await fakeHerdr("no such session");
		const handle = handleOf(await cli(["spawn", "--name", "untabbed", "--prompt", "No tab"]));
		const children = (await request({ type: "list", caller: "cli" }, { start: false })) ?? [];
		const child = children.find((found) => found.handle === handle);

		if (child === undefined) throw new Error("no child");
		await expect(openChildTab(child, herdr.env)).rejects.toThrow("no such session");
		expect(logLines(herdr.log)).toHaveLength(1);
		expect(logLines(herdr.log)[0]).toMatch(/^tab create /);
	});
});
