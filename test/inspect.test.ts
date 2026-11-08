import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { runHost } from "../src/host/run.ts";
import { type InspectFrame, type InspectServer, resolveBindHosts, startInspectServer } from "../src/inspect/index.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { statePaths } from "../src/protocol/paths.ts";
import {
	aborted,
	answerOf,
	CLI,
	called,
	cli,
	gates,
	models,
	root,
	setUp,
	spawnAs,
	startHost,
	tearDown,
	textOf,
	until,
} from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

/** The part of the reply of `/api/inspect/targets` that the tests read. */
const Targets = Type.Object({
	running: Type.Boolean(),
	targets: Type.Array(Type.Object({ handle: Type.String(), title: Type.String() })),
});

let host: Host | undefined;
let server: InspectServer | undefined;

/** The URL of the page of the inspect server, which ends with `/`. */
let base = "";

beforeAll(async () => {
	await setUp();
	// The fixture task opens a child of the children library: a target by conversation ID.
	setEntry("fixture", join(FIXTURE, "ask.ts"));
	await writeFile(
		join(root, "agent", "settings.json"),
		JSON.stringify({ retry: { enabled: false }, packages: [FIXTURE] }),
	);
	host = await startHost();
	// The mirrors of the streams must not start a real host when a test host is down.
	server = await startInspectServer({ port: 0, start: false });
	base = server.urls[0] ?? "";
});

afterAll(async () => {
	await server?.close();
	await host?.close();
	await tearDown();
});

/** The frames of an open stream as they come, the end of its body, and the abort of its request. */
type Stream = {
	readonly response: Response;
	readonly frames: InspectFrame[];
	readonly ended: Promise<void>;
	close(): void;
};

async function openStream(query: string): Promise<Stream> {
	const abort = new AbortController();
	const response = await fetch(`${base}api/inspect/stream?${query}`, { signal: abort.signal });
	const { body } = response;
	const frames: InspectFrame[] = [];

	if (body === null) throw new Error("no body");

	const ended = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			for await (const chunk of body) {
				buffer += decoder.decode(chunk, { stream: true });

				for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
					frames.push(JSON.parse(buffer.slice("data: ".length, end)));
					buffer = buffer.slice(end + 2);
				}
			}
		} catch {
			// `close()` ends the body with the error of the abort.
		}
	})();

	return { response, frames, ended, close: () => abort.abort() };
}

/** The texts of the answers in the view of `frame`. */
function answersOf(frame: InspectFrame | undefined): string[] {
	return (frame?.view?.entries ?? []).flatMap((entry) => {
		const message = entry.model?.[0];

		return entry.kind === "pi.assistant" && message !== undefined ? [textOf(message)] : [];
	});
}

function getJson(path: string): Promise<Response> {
	return fetch(`${base}api/inspect/${path}`);
}

function post(route: string, body: string, type = "application/json"): Promise<Response> {
	return fetch(`${base}api/inspect/${route}`, { method: "POST", headers: { "content-type": type }, body });
}

/** The status of `GET /api/inspect/projects` with the `Host` header `hostHeader`, which `fetch` does not send. */
function statusWithHost(hostHeader: string): Promise<number | undefined> {
	const url = new URL(base);

	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ hostname: url.hostname, port: url.port, path: "/api/inspect/projects", headers: { host: hostHeader } },
			(res) => {
				res.resume();
				resolve(res.statusCode);
			},
		);

		req.once("error", reject);
		req.end();
	});
}

/** Starts the gated fixture task of `key` with `prompt`, and gives the conversation ID of its child. */
async function startConversation(key: string, prompt: string): Promise<string> {
	const idFile = join(root, `${key}.ids.json`);
	await request({ type: "start", kind: "fixture.ask", key, input: { cwd: root, prompt, idFile } }, { start: false });
	await until(() => called(prompt) === 1);
	const ids: { child: string } = JSON.parse(await readFile(idFile, "utf8"));

	return ids.child;
}

/** A `tailscale` on `PATH` that runs the shell commands `body`. */
async function fakeTailscale(body: string): Promise<void> {
	const bin = await mkdtemp(join(root, "bin-"));
	await writeFile(join(bin, "tailscale"), `#!/bin/sh\n${body}\n`);
	await chmod(join(bin, "tailscale"), 0o755);
	process.env.PATH = `${bin}:${process.env.PATH}`;
}

/** Runs the CLI with `args` until its first line, then stops it with SIGTERM: the line, and the exit code. */
async function firstLine(args: readonly string[]): Promise<{ line: string; code: number | null }> {
	const child = spawn(process.execPath, [CLI, ...args], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
	const exited = once(child, "exit");
	let output = "";
	child.stdout.setEncoding("utf8");

	for await (const chunk of child.stdout) {
		output += chunk;

		if (output.includes("\n")) break;
	}

	child.kill("SIGTERM");
	const [code] = await exited;

	return { line: output.trim(), code };
}

describe("resolveBindHosts", () => {
	it("binds 127.0.0.1 by default, the --host alone, and refuses both --host and --tailscale", async () => {
		expect(await resolveBindHosts({})).toEqual(["127.0.0.1"]);
		expect(await resolveBindHosts({ host: "0.0.0.0" })).toEqual(["0.0.0.0"]);
		await expect(resolveBindHosts({ host: "127.0.0.1", tailscale: true })).rejects.toThrow(
			"Use --host or --tailscale, not both",
		);
	});

	it("adds the IPv4 addresses of tailscale ip -4 once, and fails without one", async () => {
		await fakeTailscale('printf "100.64.0.7\\nfd7a:115c:a1e0::7\\n100.64.0.7\\n127.0.0.1\\n"');
		expect(await resolveBindHosts({ tailscale: true })).toEqual(["127.0.0.1", "100.64.0.7"]);

		await fakeTailscale('printf "fd7a:115c:a1e0::7\\n"');
		await expect(resolveBindHosts({ tailscale: true })).rejects.toThrow("tailscale ip -4 gave no IPv4 address");

		await fakeTailscale('echo "Tailscale is stopped." >&2; exit 1');
		await expect(resolveBindHosts({ tailscale: true })).rejects.toThrow(
			"tailscale ip -4 failed: Tailscale is stopped.",
		);
	});
});

describe("the inspect server", { timeout: 30_000 }, () => {
	it("serves the page and the browser files", async () => {
		const page = await fetch(base);
		expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(await page.text()).toContain('import { mountPage } from "/assets/inspect.js"');

		const script = await fetch(`${base}assets/inspect.js`);
		expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(await script.text()).toContain("export function mountInspect(container, target, { onTitle } = {})");

		const style = await fetch(`${base}assets/inspect.css`);
		expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
		expect((await fetch(`${base}nothing`)).status).toBe(404);
	});

	it("lists the projects, and the agent and the children of the caller in a running host only", async () => {
		const dir = realpathSync(await mkdtemp(join(root, "web-")));
		expect((await cli(["create", "web", "--cwd", dir])).code).toBe(0);
		const own = await spawnAs("cli", "Inspect listed", { notify: false });
		const other = await spawnAs("other-session", "Inspect other", { notify: false });
		await answerOf(own.handle);

		expect(await (await getJson("projects")).json()).toEqual({ projects: [{ name: "web", dir }, { name: "main" }] });

		const reply = await (await getJson("targets?project=main")).json();
		expect(reply).toMatchObject({ project: "main" });
		const { running, targets } = Value.Parse(Targets, reply);
		expect(running).toBe(true);
		// The child of another caller is not listed.
		expect(targets.map((target) => target.handle)).toEqual(["agent", own.handle]);
		expect(targets.map((target) => target.title)).toEqual(["main agent", own.handle]);
		expect(other.handle).not.toBe(own.handle);

		// The host of web does not run, and the list does not start it.
		expect(await (await getJson("targets?project=web")).json()).toEqual({
			project: "web",
			running: false,
			targets: [],
		});
		expect(existsSync(statePaths("web").socket)).toBe(false);

		const unknown = await getJson("targets?project=nosuch");
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toEqual({ error: "Unknown harness project: nosuch" });
		const noProject = await getJson("targets");
		expect(noProject.status).toBe(400);
		expect(await noProject.json()).toEqual({ error: "Invalid query: must have required properties project" });
	});

	it("refuses a Host header that is not an address, a body that is not valid JSON, and unknown routes", async () => {
		expect(await statusWithHost("evil.example")).toBe(403);
		expect(await statusWithHost(new URL(base).host.replace("127.0.0.1", "localhost"))).toBe(200);

		const refusals: [Response, string][] = [
			[await post("input", "{}", "text/plain"), "The body must be application/json"],
			[await post("input", "{"), "The body is not JSON"],
			[await post("input", JSON.stringify({ project: "main", message: " " })), "The message is empty"],
			[
				await post("input", JSON.stringify({ project: "main", handle: "a", conversation: "1", message: "Hi" })),
				"Give handle or conversation, not both",
			],
			[await post("input", "x".repeat(1024 * 1024 + 1)), "The body is longer than 1 MiB"],
			[await post("abort", JSON.stringify({ project: "nosuch" })), "Unknown harness project: nosuch"],
			[await getJson("stream?project=main&handle=a&conversation=1"), "Give handle or conversation, not both"],
		];

		for (const [response, error] of refusals) {
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error });
		}

		expect((await post("input", JSON.stringify({ message: "Hi" }))).status).toBe(400);
		expect((await getJson("nothing")).status).toBe(404);
	});

	it("refuses to listen on a host name, which the routes would refuse, and listens on localhost", async () => {
		await expect(startInspectServer({ hosts: ["inspect.invalid"], port: 0, start: false })).rejects.toThrow(
			"The host must be an IP address or localhost: inspect.invalid",
		);

		const local = await startInspectServer({ hosts: ["localhost"], port: 0, start: false });

		try {
			expect(local.urls).toEqual([expect.stringMatching(/^http:\/\/localhost:\d+\/$/)]);
			expect((await fetch(`${local.urls[0]}api/inspect/projects`)).status).toBe(200);
		} finally {
			await local.close();
		}
	});

	it("streams the conversation of a child, and starts a new turn of the idle child with input", async () => {
		const child = await spawnAs("cli", "Inspect streamed", { notify: false });
		await answerOf(child.handle);
		const stream = await openStream(`project=main&handle=${child.handle}`);

		try {
			expect(stream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
			await until(() => stream.frames.some((frame) => frame.status.kind === "open"));
			expect(stream.frames[0]).toEqual({ status: { kind: "connecting" }, title: child.handle });

			const open = stream.frames.find((frame) => frame.status.kind === "open");
			expect(open).toMatchObject({ title: child.handle, child: { handle: child.handle, state: "idle" } });
			expect(open?.summary).toMatchObject({ statusText: "", queued: [] });
			expect(answersOf(open)).toEqual(["Answer to Inspect streamed"]);

			const again = JSON.stringify({ project: "main", handle: child.handle, message: "Inspect again" });
			expect(await (await post("input", again)).json()).toEqual({ ok: true });
			await until(() => answersOf(stream.frames.at(-1)).includes("Answer to Inspect again"));
			expect(stream.frames.some((frame) => frame.child?.state === "busy")).toBe(true);
			await until(() => stream.frames.at(-1)?.child?.state === "idle");
			expect(stream.frames.at(-1)?.summary?.usageTotals).toMatchObject({ cost: expect.any(Number) });
		} finally {
			stream.close();
		}
	});

	it("shows a busy turn, and aborts it", async () => {
		gates.set("Inspect gated", Promise.withResolvers());
		const child = await spawnAs("cli", "Inspect gated", { notify: false });
		const stream = await openStream(`project=main&handle=${child.handle}`);

		try {
			await until(() => called("Inspect gated") === 1);
			await until(() => stream.frames.some((frame) => frame.child?.state === "busy"));
			const busy = stream.frames.find((frame) => frame.child?.state === "busy");
			expect(busy?.summary?.statusText).toBe("Working... (esc to interrupt)");

			const stopped = await post("abort", JSON.stringify({ project: "main", handle: child.handle }));
			expect(await stopped.json()).toEqual({ ok: true });
			expect(aborted.has("Inspect gated")).toBe(true);
			await until(() => stream.frames.at(-1)?.child?.state === "idle");
		} finally {
			stream.close();
			gates.delete("Inspect gated");
		}
	});

	it("steers a busy conversation, and gives the refusal of the host for an idle one", async () => {
		gates.set("Inspect conversation", Promise.withResolvers());
		const id = await startConversation("inspected", "Inspect conversation");
		const stream = await openStream(`project=main&conversation=${id}`);

		try {
			await until(() => stream.frames.some((frame) => frame.status.kind === "open"));
			const key = stream.frames.find((frame) => frame.status.kind === "open")?.child?.name;
			expect(stream.frames[0]?.title).toBe(id);
			expect(stream.frames.at(-1)?.title).toBe(key);

			const steer = JSON.stringify({ project: "main", conversation: id, message: "Inspect steer" });
			expect(await (await post("input", steer)).json()).toEqual({ ok: true });
			gates.get("Inspect conversation")?.resolve();
			await until(() => called("Inspect steer") === 1);
			await until(() => stream.frames.at(-1)?.child?.state === "idle");

			const refused = await post("input", steer);
			expect(refused.status).toBe(500);
			expect(await refused.json()).toEqual({ error: `${key} takes input only while it works` });
		} finally {
			stream.close();
			gates.delete("Inspect conversation");
		}
	});

	it("ends the stream of an unknown child after one failed frame", async () => {
		const stream = await openStream("project=main&handle=nosuch");
		await stream.ended;

		expect(stream.frames.at(-1)).toEqual({
			status: { kind: "failed", reason: "Unknown subagent: nosuch" },
			title: "nosuch",
		});
	});

	it("closes the mirror of a stream when the client disconnects", async () => {
		const dir = realpathSync(await mkdtemp(join(root, "idle-")));
		expect((await cli(["create", "idle", "--cwd", dir])).code).toBe(0);
		// The host exits once it has no connection for 300 ms: the open mirror is one.
		const idle = await runHost({ project: "idle", cwd: dir, models, idleExitMs: 300 });

		if (idle === undefined) throw new Error("no host");
		let closed = false;
		void idle.closed.then(() => (closed = true));
		const stream = await openStream("project=idle");

		try {
			await until(() => stream.frames.some((frame) => frame.status.kind === "open"));
			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(closed).toBe(false);
		} finally {
			stream.close();
		}

		await until(() => closed);
	});
});

describe("harness inspect", { timeout: 30_000 }, () => {
	it("prints the URL of the page with the target of its arguments, and stops on SIGTERM", async () => {
		const url = /^http:\/\/127\.0\.0\.1:\d+\/$/;

		const child = await firstLine(["inspect", "a1b2c3", "--port", "0"]);
		expect(child.code).toBe(0);
		expect(child.line).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?project=main&handle=a1b2c3$/);
		expect((await firstLine(["--project", "main", "inspect", "--port", "0"])).line).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/\?project=main$/,
		);
		expect((await firstLine(["inspect", "--conversation", "42", "--port", "0"])).line).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/\?project=main&conversation=42$/,
		);
		expect((await firstLine(["inspect", "--port", "0"])).line).toMatch(url);
	});

	it("refuses arguments that it does not take", async () => {
		expect(await cli(["inspect", "--host", "127.0.0.1", "--tailscale"])).toMatchObject({
			code: 1,
			stderr: "Use --host or --tailscale, not both\n",
		});
		expect(await cli(["inspect", "--port", "x"])).toMatchObject({
			code: 1,
			stderr: "--port must be an integer from 0 to 65535\n",
		});
		expect(await cli(["inspect", "--host", "inspect.invalid", "--port", "0"])).toMatchObject({
			code: 1,
			stderr: "The host must be an IP address or localhost: inspect.invalid\n",
		});
		expect(await cli(["inspect", "--nope"])).toMatchObject({ code: 1, stderr: "Unknown inspect argument: --nope\n" });
		expect((await cli(["inspect", "a1b2c3", "--conversation", "42"])).stderr).toContain(
			"harness inspect [<handle> | --conversation <id>] [--port <n>] [--host <ip> | --tailscale]",
		);
	});
});
