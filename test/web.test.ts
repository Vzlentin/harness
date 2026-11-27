import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { connect, request } from "../src/client/client.ts";
import type { Host } from "../src/host/run.ts";
import { setEntry } from "../src/protocol/entries.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { called, cli, root, send, setSettings, setUp, spawnWithId, startHost, tearDown, until } from "./helpers.ts";

const INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>demo</title>
</head>
<body>
<p>demo</p>
</body>
</html>
`;

/** The fixture entry, whose task opens a library conversation that is not a child. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks");

let host: Host | undefined;

/** The child whose conversation serves the folder of the tests, by handle and conversation ID. */
let child = { handle: "", id: "" };

/** The folder of the tests, its link, and the origin of the web server. */
let folder = "";
let link = "";
let origin = "";

beforeAll(async () => {
	await setUp();
	setEntry("fixture", join(FIXTURE, "ask.ts"));
	await setSettings({ defaultProvider: "faux", defaultModel: "faux-1", packages: [FIXTURE] });
	host = await startHost();
	child = await spawnWithId("pi-web");
	folder = await mkdtemp(join(root, "site-"));
	await writeFile(join(folder, "index.html"), INDEX);
	await writeFile(join(folder, "data.bin"), Buffer.from([0xff, 0x00, 0xfe]));
	await writeFile(join(folder, ".hidden"), "hidden");
	await mkdir(join(folder, "sub"));
	await writeFile(join(folder, "sub", "page.html"), "<p>no head</p>");
	await writeFile(join(root, "secret.txt"), "secret");
	await symlink(join(root, "secret.txt"), join(folder, "out.txt"));
	await symlink(join(folder, "data.bin"), join(folder, "in.bin"));
	const { urls } = await send({ type: "serve", caller: child.id, dir: folder });
	expect(urls).toHaveLength(1);
	link = urls[0] ?? "";
	origin = new URL(link).origin;
}, 30_000);

afterAll(async () => {
	await host?.close();
	await tearDown();
});

/** The status and the body of a request to the web server, with the path as it is and the `Host` header `host`. */
function rawRequest(
	path: string,
	options: { readonly host?: string; readonly method?: string; readonly body?: string } = {},
): Promise<{ readonly status: number | undefined; readonly body: Buffer }> {
	const url = new URL(origin);

	return new Promise((resolve, reject) => {
		const headers = { host: options.host ?? url.host, "content-type": "application/json" };

		const req = httpRequest(
			{ hostname: url.hostname, port: url.port, path, method: options.method ?? "GET", headers },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.once("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
			},
		);

		req.once("error", reject);
		req.end(options.body);
	});
}

/** The reply of a Send: whether the key was there, or the error. */
const SendReply = Type.Object({
	ok: Type.Optional(Type.Boolean()),
	repeated: Type.Optional(Type.Boolean()),
	error: Type.Optional(Type.String()),
});

/** The `window` of the page script, with the call that it defines. */
type PageWindow = { sendPrompt?: (text: string) => Promise<void> };

/** Posts a Send of `message` with `key` to the folder of the tests, and gives the reply. */
async function sendPost(message: string, key: string): Promise<Static<typeof SendReply>> {
	const reply = await fetch(link, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message, key }),
	});

	return Value.Parse(SendReply, await reply.json());
}

/** The first frame of the stream of the query `query`. */
async function firstFrame(query: string): Promise<{ status: { kind: string }; child?: { handle: string } }> {
	const abort = new AbortController();
	const reply = await fetch(`${origin}/api/inspect/stream?${query}`, { signal: abort.signal });
	const reader = reply.body?.getReader();
	let text = "";

	try {
		while (reader !== undefined && !text.includes("\n\n")) {
			const { value, done } = await reader.read();

			if (done) break;
			text += Buffer.from(value).toString("utf8");
		}
	} finally {
		abort.abort();
	}

	return JSON.parse(/^data: (.*)\n\n/.exec(text)?.[1] ?? "null");
}

describe("the web server of the host", { timeout: 30_000 }, () => {
	it("gives the links of a folder on the port that web.json keeps", () => {
		const { port } = JSON.parse(readFileSync(join(statePaths("main").dir, "web.json"), "utf8"));
		expect(link).toBe(`http://127.0.0.1:${port}/${child.id}/${basename(folder)}/`);
	});

	it("serves the files of a folder as they are now, and adds the Send script to an HTML file with a head", async () => {
		const path = new URL(link).pathname;
		const index = (await rawRequest(path)).body.toString("utf8");
		expect(index).toContain("window.sendPrompt");
		expect(index.replace(/<script>[\s\S]*<\/script>\n/, "")).toBe(INDEX);
		expect((await rawRequest(`${path}sub/page.html`)).body.toString("utf8")).toBe("<p>no head</p>");
		expect((await rawRequest(`${path}data.bin`)).body).toEqual(Buffer.from([0xff, 0x00, 0xfe]));
		expect((await rawRequest(`${path}in.bin`)).body).toEqual(Buffer.from([0xff, 0x00, 0xfe]));
		await writeFile(join(folder, "data.bin"), "changed");
		expect((await rawRequest(`${path}data.bin`)).body.toString("utf8")).toBe("changed");
	});

	it("refuses a hidden name, a way out of the folder, a folder, an unknown folder, and a DNS Host header", async () => {
		const path = new URL(link).pathname;

		for (const each of [".hidden", "out.txt", "sub", "..%2Fsecret.txt", "sub/..%2F..%2Fsecret.txt", "missing"]) {
			expect((await rawRequest(`${path}${each}`)).status, each).toBe(404);
		}

		expect((await rawRequest(`/${child.id}/other/index.html`)).status).toBe(404);
		expect((await rawRequest(path, { host: "evil.example" })).status).toBe(403);
		expect((await rawRequest("/assets/inspect.js", { host: "evil.example" })).status).toBe(403);
	});

	it("sends the text of a Send to the hosted child once for each key", async () => {
		expect(await sendPost("Web send", "k1")).toEqual({ ok: true, repeated: false });
		await until(() => called("Web send") === 1);
		expect(await sendPost("Web send", "k1")).toEqual({ ok: true, repeated: true });
		expect(await sendPost("  ", "k3")).toMatchObject({ error: "The message is empty" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(called("Web send")).toBe(1);
	});

	it("aborts with the abort route and does not send a message of its body", async () => {
		const body = JSON.stringify({ host: "main", handle: child.handle, message: "Abort prompt" });
		const reply = await rawRequest("/api/inspect/abort", { method: "POST", body });
		expect(JSON.parse(reply.body.toString("utf8"))).toEqual({ ok: true });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(called("Abort prompt")).toBe(0);
	});

	it("keeps the key of a text in the page script, which shows already sent for a repeat", async () => {
		const index = (await rawRequest(new URL(link).pathname)).body.toString("utf8");
		const code = /<script>([\s\S]*)<\/script>/.exec(index)?.[1] ?? "";
		const body: { className: string; textContent: string }[] = [];
		const window: PageWindow = {};

		const document = {
			createElement: () => {
				const element = {
					className: "",
					style: {},
					textContent: "",
					remove: () => body.splice(body.indexOf(element), 1),
				};

				return element;
			},
			body: { append: (element: { className: string; textContent: string }) => body.push(element) },
		};

		const globals = {
			window,
			document,
			crypto,
			setTimeout,
			fetch: (path: string, init: RequestInit) => fetch(new URL(path, origin), init),
		};

		runInNewContext(code, globals);
		const line = () => body.find((element) => element.className === "harness-send")?.textContent;
		await window.sendPrompt?.("Page send");
		expect(line()).toBe("sent \u2713");
		await window.sendPrompt?.("Page send");
		expect(line()).toBe("already sent \u2713");
		await until(() => called("Page send") === 1);
	});

	it("gives a Pi session the text of a Send in the reply of its answers request", async () => {
		const session = "pi-web-session";
		const client = await connect({ start: false });

		if (client === undefined) throw new Error("no host");

		try {
			const pending = client.request({ type: "answers", caller: session });

			// The host knows the session once it opened its request.
			const { urls } = await vi.waitFor(() => send({ type: "serve", caller: session, dir: folder }), {
				timeout: 10_000,
			});

			const reply = await fetch(urls[0] ?? "", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "To the session", key: "k2" }),
			});

			expect(await reply.json()).toEqual({ ok: true, repeated: false });
			expect(await pending).toEqual([{ source: "entry", key: "k2", text: "To the session" }]);
		} finally {
			client.close();
		}
	});

	it("streams the host agent and a child, and serves the page of each conversation", async () => {
		expect(await firstFrame("host=main")).toMatchObject({ status: { kind: "open" }, child: { handle: "agent" } });
		expect(await firstFrame(`host=main&handle=${child.handle}`)).toMatchObject({
			status: { kind: "open" },
			child: { handle: child.handle },
		});
		expect((await rawRequest("/api/inspect/stream?host=other")).status).toBe(400);
		expect((await rawRequest(`/${ROOT_CONVERSATION_ID}/`)).body.toString("utf8")).toContain('{"host":"main"}');
		expect((await rawRequest(`/${child.id}/`)).body.toString("utf8")).toContain(
			`{"host":"main","handle":"${child.handle}"}`,
		);
		expect((await rawRequest("/unknown/")).status).toBe(404);
	});

	it("serves the page of a library conversation that is not a child", async () => {
		const idFile = join(root, "web-task.ids.json");
		const input = { cwd: root, prompt: "Web task", idFile };
		await request({ type: "start", kind: "fixture.ask", key: "web-task", input }, { start: false });
		await until(() => called("Web task") === 1);
		const ids: { child: string } = JSON.parse(await readFile(idFile, "utf8"));
		const page = (await rawRequest(`/${ids.child}/`)).body.toString("utf8");
		expect(page).toContain(`{"host":"main","conversation":"${ids.child}"}`);
	});

	it("prints the links with harness serve, and refuses a caller that is not of the host", async () => {
		expect(await cli(["serve", folder], { PI_SESSION_ID: child.id })).toEqual({
			code: 0,
			stdout: `${link}\n`,
			stderr: "",
		});
		expect((await cli(["serve", folder], { PI_SESSION_ID: "stranger" })).stderr).toBe(
			"stranger is not a conversation or a Pi session of the host\n",
		);
	});

	it("listens on the same port after a restart", async () => {
		await host?.close();
		host = await startHost();
		expect((await rawRequest(new URL(link).pathname)).status).toBe(200);
	});
});
