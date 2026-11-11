import { existsSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Host } from "../src/host/run.ts";
import { type InspectServer, startInspectServer } from "../src/inspect/index.ts";
import { addSend } from "../src/inspect/pages.ts";
import { pageDir } from "../src/protocol/paths.ts";
import { answerOf, called, cli, openWatch, root, setUp, spawnAs, startHost, tearDown, until } from "./helpers.ts";

const INDEX = `<!doctype html>
<html lang="en">
<HEAD>
<meta charset="utf-8">
<title>demo</title>
</HEAD>
<body>
<p>demo</p>
</body>
</html>
`;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n';

/** Bytes that are not UTF-8, so that a reply that decodes them as text changes them. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 256 }, (_, i) => i)]);

const USAGE = "harness page <folder> --slug <slug> [<handle> | --conversation <id>]";

const NO_SERVER = "  (no server listens: harness inspect serves the pages)";

let host: Host | undefined;
let server: InspectServer | undefined;

/** The URL of `/` of the inspect server, which ends with `/`, and its port. */
let base = "";
let port = "";

beforeAll(async () => {
	await setUp();
	host = await startHost();
	server = await startInspectServer({ port: 0, start: false });
	base = server.urls[0] ?? "";
	port = new URL(base).port;
});

afterAll(async () => {
	await server?.close();
	await host?.close();
	await tearDown();
});

/** A new folder with `files`, by name. */
async function pageFolder(files: Readonly<Record<string, string | Buffer>>): Promise<string> {
	const folder = await mkdtemp(join(root, "page-"));

	for (const [name, data] of Object.entries(files)) await writeFile(join(folder, name), data);

	return folder;
}

/** The status, the content type and the body of a request to the inspect server, with the `Host` header `host`. */
type RawReply = { readonly status: number | undefined; readonly type: string | undefined; readonly body: Buffer };

/** Sends `path` as it is, which `fetch` does not: it removes the `..` segments. */
function rawRequest(
	path: string,
	options: { readonly host?: string; readonly method?: string } = {},
): Promise<RawReply> {
	const url = new URL(base);

	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: url.hostname,
				port: url.port,
				path,
				method: options.method ?? "GET",
				headers: { host: options.host ?? url.host },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.once("end", () =>
					resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks) }),
				);
			},
		);

		req.once("error", reject);
		req.end();
	});
}

/**
 * The code of the script that `served` adds to `original`. It checks that `served` is `original` with one `<script>`
 * element just before its first `</head>`.
 */
function addedScript(served: string, original: string): string {
	const at = original.search(/<\/head>/i);
	const added = served.slice(at, served.length - (original.length - at));
	expect(served.slice(0, at) + served.slice(at + added.length)).toBe(original);
	expect(added.match(/<script>/g)).toHaveLength(1);
	expect(added.match(/<\/script>/g)).toHaveLength(1);
	const code = /^<script>([\s\S]*)<\/script>\n$/.exec(added)?.[1];

	if (code === undefined) throw new Error(`no script in ${added}`);

	return code;
}

/** An element of the stub document: the line or the layer of the Send. */
type Element = { className: string; style: { cssText?: string }; textContent: string; remove: () => void };

/** The page of a script that runs in `node:vm`: its `window`, and the elements in its body. */
type Page = { readonly window: { sendPrompt?: (text: string) => Promise<void> }; readonly body: Element[] };

/** What a page script gets in place of the browser's `fetch` and `setTimeout`. */
type PageGlobals = {
	readonly fetch: (path: string, init: RequestInit) => Promise<Response>;
	readonly setTimeout: (callback: () => void, ms: number) => void;
};

/** The real `fetch`, with paths against the inspect server, and the real `setTimeout`. */
function liveGlobals(): PageGlobals {
	return {
		fetch: (path, init) => fetch(new URL(path, base), init),
		setTimeout: (callback, ms) => {
			setTimeout(callback, ms);
		},
	};
}

/** Runs `code` with a stub document and `globals`. */
function runPage(code: string, globals: PageGlobals = liveGlobals()): Page {
	const page: Page = { window: {}, body: [] };

	const document = {
		createElement: (): Element => {
			const element: Element = {
				className: "",
				style: {},
				textContent: "",
				remove: () => page.body.splice(page.body.indexOf(element), 1),
			};

			return element;
		},
		body: { append: (element: Element) => page.body.push(element) },
	};

	runInNewContext(code, { window: page.window, document, ...globals });

	return page;
}

/** The texts of the lines of the Send in `page`. */
function lines(page: Page): string[] {
	return page.body.filter((element) => element.className === "harness-send").map((element) => element.textContent);
}

/** The number of layers of the Send in `page`. */
function layers(page: Page): number {
	return page.body.filter((element) => element.className === "harness-send-layer").length;
}

/** A post of the fake `fetch`: its body, and the function that answers it. */
type Post = { readonly body: Promise<string>; readonly answer: (response: Response | Error) => void };

/** Fake `fetch` and `setTimeout`: the test answers each post and fires each timer. */
type FakePage = {
	readonly page: Page;
	readonly posts: Post[];
	readonly timers: Array<{ ms: number; fire: () => void }>;
};

function fakePage(): FakePage {
	const posts: Post[] = [];
	const timers: Array<{ ms: number; fire: () => void }> = [];

	const globals: PageGlobals = {
		fetch: (_path, init) =>
			new Promise((resolve, reject) => {
				posts.push({
					body: new Response(init.body).text(),
					answer: (response) => (response instanceof Error ? reject(response) : resolve(response)),
				});
			}),
		setTimeout: (callback, ms) => {
			timers.push({ ms, fire: callback });
		},
	};

	const page = runPage(addedScript(addSend(INDEX, { project: "main", handle: "a1b2c3" }), INDEX), globals);

	return { page, posts, timers };
}

/** Lets the pending promise callbacks run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
}

/** A reply of the input route. */
function inputReply(status: number, body: { readonly error?: string } = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function sendPrompt(page: Page, text: string): Promise<void> {
	if (page.window.sendPrompt === undefined) throw new Error("the script did not define sendPrompt");
	await page.window.sendPrompt(text);
}

describe("harness page", { timeout: 30_000 }, () => {
	it("copies the page and prints its link for the child of PI_SESSION_ID", async () => {
		const child = await spawnAs("cli", "Page child", { notify: false });
		await answerOf(child.handle);
		const watched = await openWatch({ kind: "child", handle: child.handle });
		watched.client.close();
		const session = { PI_SESSION_ID: String(watched.view.conversation.id) };

		const folder = await pageFolder({ "index.html": INDEX, "fig.svg": SVG, ".hidden": "secret" });
		await mkdir(join(folder, "sub"));
		await writeFile(join(folder, "sub", "inner.html"), INDEX);
		await symlink(join(folder, "index.html"), join(folder, "link.html"));

		expect(await cli(["page", folder, "--slug", "demo", "--port", port], session)).toEqual({
			code: 0,
			stdout: `${base}pages/demo/?project=main&handle=${child.handle}\n`,
			stderr: "",
		});
		expect(readdirSync(pageDir("demo")).sort()).toEqual(["fig.svg", "index.html"]);
		expect(await readFile(join(pageDir("demo"), "fig.svg"), "utf8")).toBe(SVG);

		// A second copy replaces the first one.
		const next = await pageFolder({ "index.html": INDEX });
		expect((await cli(["page", next, "--slug", "demo", "--port", port], session)).code).toBe(0);
		expect(readdirSync(pageDir("demo"))).toEqual(["index.html"]);
	});

	it("copies the copy of a slug onto itself", async () => {
		const folder = await pageFolder({ "index.html": INDEX, "fig.svg": SVG });
		expect((await cli(["page", folder, "--slug", "self", "a1b2c3", "--port", port])).code).toBe(0);

		expect(await cli(["page", pageDir("self"), "--slug", "self", "a1b2c3", "--port", port])).toEqual({
			code: 0,
			stdout: `${base}pages/self/?project=main&handle=a1b2c3\n`,
			stderr: "",
		});
		expect(readdirSync(pageDir("self")).sort()).toEqual(["fig.svg", "index.html"]);
		expect(await readFile(join(pageDir("self"), "index.html"), "utf8")).toBe(INDEX);
		expect(await readFile(join(pageDir("self"), "fig.svg"), "utf8")).toBe(SVG);
		expect(readdirSync(dirname(pageDir("self"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	// Root reads a file with mode 000, so the copy does not fail.
	it.skipIf(process.getuid?.() === 0)("keeps the earlier copy when a file cannot be read", async () => {
		const folder = await pageFolder({ "index.html": INDEX, "fig.svg": SVG });
		expect((await cli(["page", folder, "--slug", "unread", "a1b2c3", "--port", port])).code).toBe(0);
		await writeFile(join(folder, "index.html"), "<p>new</p>\n");
		await chmod(join(folder, "fig.svg"), 0o000);

		expect(await cli(["page", folder, "--slug", "unread", "a1b2c3", "--port", port])).toMatchObject({
			code: 1,
			stdout: "",
			stderr: expect.stringContaining("EACCES"),
		});
		expect(readdirSync(pageDir("unread")).sort()).toEqual(["fig.svg", "index.html"]);
		expect(await readFile(join(pageDir("unread"), "index.html"), "utf8")).toBe(INDEX);
		expect(readdirSync(dirname(pageDir("unread"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("gives the project agent for its conversation ID, and the target of its arguments", async () => {
		const folder = await pageFolder({ "index.html": INDEX });
		const agent = { PI_SESSION_ID: String(ROOT_CONVERSATION_ID) };

		expect(await cli(["page", folder, "--slug", "agent-page", "--port", port], agent)).toMatchObject({
			code: 0,
			stdout: `${base}pages/agent-page/?project=main\n`,
		});
		// An explicit target needs no PI_SESSION_ID.
		expect(await cli(["page", folder, "--slug", "conv", "--conversation", "42", "--port", port])).toMatchObject({
			code: 0,
			stdout: `${base}pages/conv/?project=main&conversation=42\n`,
		});
	});

	it("notes an address where no server listens", async () => {
		const spare = await startInspectServer({ port: 0, start: false });
		const closed = new URL(spare.urls[0] ?? "").port;
		await spare.close();
		const folder = await pageFolder({ "index.html": INDEX });

		expect(await cli(["page", folder, "--slug", "closed", "a1b2c3", "--port", closed])).toEqual({
			code: 0,
			stdout: `http://127.0.0.1:${closed}/pages/closed/?project=main&handle=a1b2c3${NO_SERVER}\n`,
			stderr: "",
		});
	});

	it("refuses a caller that is not a child or the project agent, and keeps the old page", async () => {
		const first = await pageFolder({ "index.html": INDEX });
		expect((await cli(["page", first, "--slug", "kept", "a1b2c3", "--port", port])).code).toBe(0);
		const other = await pageFolder({ "index.html": "<p>other</p>\n" });

		expect(await cli(["page", other, "--slug", "kept", "--port", port], { PI_SESSION_ID: "other" })).toEqual({
			code: 1,
			stdout: "",
			stderr: "The caller other is not a child or the project agent of this host\n",
		});
		expect(await readFile(join(pageDir("kept"), "index.html"), "utf8")).toBe(INDEX);

		expect(await cli(["page", other, "--slug", "unset", "--port", port])).toEqual({
			code: 1,
			stdout: "",
			stderr: "Give <handle> or --conversation <id>: PI_SESSION_ID is not set\n",
		});
		expect(existsSync(pageDir("unset"))).toBe(false);

		const dir = realpathSync(await mkdtemp(join(root, "web-")));
		expect((await cli(["create", "web", "--cwd", dir])).code).toBe(0);
		expect(await cli(["--project", "web", "page", other, "--slug", "down"], { PI_SESSION_ID: "other" })).toEqual({
			code: 1,
			stdout: "",
			stderr: "The harness host of web is not running\n",
		});
		expect(existsSync(pageDir("down"))).toBe(false);
	});

	it("refuses a bad slug, a folder without index.html, a host name, and arguments that it does not take", async () => {
		const folder = await pageFolder({ "index.html": INDEX });
		const empty = await pageFolder({ "fig.svg": SVG });
		const file = join(folder, "index.html");

		const failures: [string[], string][] = [
			[["page", folder, "--slug", "Bad_slug", "a1"], "The slug must be lowercase words with hyphens: Bad_slug\n"],
			[["page", empty, "--slug", "empty", "a1"], `No index.html in ${empty}\n`],
			[["page", file, "--slug", "file", "a1"], `No index.html in ${file}\n`],
			[
				["page", folder, "--slug", "named", "a1", "--host", "example.com"],
				"The host must be an IP address or localhost: example.com\n",
			],
			[["page", folder, "--slug", "demo", "--nope"], "Unknown page argument: --nope\n"],
			[["page", folder, "--slug"], "--slug requires a value\n"],
		];

		const results = await Promise.all(failures.map(([args]) => cli(args)));
		expect(results).toEqual(failures.map(([, stderr]) => ({ code: 1, stdout: "", stderr })));

		for (const slug of ["empty", "file", "named"]) expect(existsSync(pageDir(slug))).toBe(false);

		const usages = [
			["page"],
			["page", folder],
			["page", "--slug", "demo", folder],
			["page", folder, "--slug", "demo", "a1", "--conversation", "42"],
			["page", folder, "--slug", "demo", "a1", "b2"],
		];

		for (const result of await Promise.all(usages.map((args) => cli(args)))) {
			expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining(USAGE) });
		}
	});
});

describe("the Send of a page", { timeout: 30_000 }, () => {
	it("posts the answer line to the idle child of the link, which starts a turn", async () => {
		const child = await spawnAs("cli", "Page send", { notify: false });
		await answerOf(child.handle);
		const folder = await pageFolder({ "index.html": INDEX });
		const printed = await cli(["page", folder, "--slug", "send", child.handle, "--port", port]);
		const reply = await fetch(printed.stdout.trim());
		expect(reply.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const page = runPage(addedScript(await reply.text(), INDEX));

		await sendPrompt(page, "[demo] 1a ok");
		await until(() => called("[demo] 1a ok") === 1);
		expect(lines(page)).toEqual(["sent \u2713"]);
		expect(layers(page)).toBe(0);
	});

	it("shows the refusal of the server, and keeps a target that closes the script as text", async () => {
		const folder = await pageFolder({ "index.html": INDEX });
		expect((await cli(["page", folder, "--slug", "refused", "a1b2c3", "--port", port])).code).toBe(0);
		const handle = "</script><b>";
		const link = `${base}pages/refused/?project=main&handle=${encodeURIComponent(handle)}`;
		const served = await (await fetch(link)).text();
		expect(served).not.toContain(handle);
		const page = runPage(addedScript(served, INDEX));

		await sendPrompt(page, "Page refused");
		await sendPrompt(page, "Page refused");
		expect(lines(page)).toEqual([`not sent: Unknown subagent: ${handle}`]);
		expect(called("Page refused")).toBe(0);
	});

	it("covers the page while it posts, and shows sent at the later of the reply and 400 ms", async () => {
		const { page, posts, timers } = fakePage();

		const sending = sendPrompt(page, "one");
		await flush();
		expect(lines(page)).toEqual(["sending\u2026"]);
		expect(layers(page)).toBe(1);
		expect(await Promise.all(posts.map(async (post) => post.body))).toEqual([
			JSON.stringify({ project: "main", handle: "a1b2c3", message: "one" }),
		]);
		expect(timers.map((timer) => timer.ms)).toEqual([400]);

		posts[0]?.answer(inputReply(200));
		await flush();
		expect(lines(page)).toEqual(["sending\u2026"]);
		expect(layers(page)).toBe(1);

		timers[0]?.fire();
		await sending;
		expect(lines(page)).toEqual(["sent \u2713"]);
		expect(layers(page)).toBe(0);
	});

	it("waits for a slow reply after the 400 ms", async () => {
		const { page, posts, timers } = fakePage();

		const sending = sendPrompt(page, "one");
		await flush();
		timers[0]?.fire();
		await flush();
		expect(lines(page)).toEqual(["sending\u2026"]);
		expect(layers(page)).toBe(1);

		posts[0]?.answer(inputReply(409, { error: "busy" }));
		await sending;
		expect(lines(page)).toEqual(["not sent: busy"]);
		expect(layers(page)).toBe(0);
	});

	it("ignores a call while a post runs", async () => {
		const { page, posts, timers } = fakePage();

		const sending = sendPrompt(page, "one");
		await flush();
		await sendPrompt(page, "two");
		expect(posts).toHaveLength(1);
		expect(lines(page)).toEqual(["sending\u2026"]);
		expect(layers(page)).toBe(1);

		posts[0]?.answer(inputReply(200));
		timers[0]?.fire();
		await sending;
		expect(lines(page)).toEqual(["sent \u2713"]);
	});

	it("does not post the text of the last success again, and posts a failed text again", async () => {
		const { page, posts, timers } = fakePage();

		const first = sendPrompt(page, "A");
		await flush();
		posts[0]?.answer(inputReply(200));
		timers[0]?.fire();
		await first;

		await sendPrompt(page, "A");
		expect(posts).toHaveLength(1);
		expect(lines(page)).toEqual(["already sent \u2713"]);
		expect(layers(page)).toBe(0);

		const second = sendPrompt(page, "B");
		await flush();
		posts[1]?.answer(new Error("offline"));
		timers[1]?.fire();
		await second;
		expect(lines(page)).toEqual(["not sent: offline"]);

		const third = sendPrompt(page, "B");
		await flush();
		expect(posts).toHaveLength(3);
		posts[2]?.answer(inputReply(500));
		timers[2]?.fire();
		await third;
		expect(lines(page)).toEqual(["not sent: 500"]);

		await sendPrompt(page, "A");
		expect(posts).toHaveLength(3);
		expect(lines(page)).toEqual(["already sent \u2713"]);
	});

	it("serves the script as ASCII", () => {
		expect(addSend(INDEX, { project: "main" })).not.toMatch(/[^\t\n -~]/);
	});
});

describe("the page route", { timeout: 30_000 }, () => {
	beforeAll(async () => {
		const folder = await pageFolder({ "index.html": INDEX, "fig.svg": SVG, "pic.png": PNG });
		expect((await cli(["page", folder, "--slug", "files", "a1b2c3", "--port", port])).code).toBe(0);
		await writeFile(join(pageDir("files"), ".hidden"), "secret");
		await mkdir(join(pageDir("files"), "sub.html"));
		const other = await pageFolder({ "index.html": "<p>other</p>\n" });
		expect((await cli(["page", other, "--slug", "other", "a1b2c3", "--port", port])).code).toBe(0);
	});

	it("serves each file as its bytes without a query, and an HTML file without the script", async () => {
		const index = await rawRequest("/pages/files/");
		expect(index).toMatchObject({ status: 200, type: "text/html; charset=utf-8" });
		expect(index.body.equals(Buffer.from(INDEX))).toBe(true);
		expect((await rawRequest("/pages/files/index.html")).body.equals(Buffer.from(INDEX))).toBe(true);

		// A target in the query adds the script only to an HTML file.
		const svg = await rawRequest("/pages/files/fig.svg?project=main");
		expect(svg).toMatchObject({ status: 200, type: "image/svg+xml" });
		expect(svg.body.equals(Buffer.from(SVG))).toBe(true);

		const png = await rawRequest("/pages/files/pic.png");
		expect(png).toMatchObject({ status: 200, type: "image/png" });
		expect(png.body.equals(PNG)).toBe(true);
	});

	it("refuses a path out of the page, a hidden file, a folder, a missing file and a bad slug with 404", async () => {
		expect((await rawRequest("/pages/other/")).status).toBe(200);

		for (const path of [
			"/pages/files/..%2Fother%2Findex.html",
			"/pages/files/.hidden",
			"/pages/files/sub.html",
			"/pages/files/missing.html",
			"/pages/files/a%00.html",
			"/pages/files/%E0%A4%A",
			"/pages/files/sub/index.html",
			"/pages/files",
			"/pages/Bad/",
		]) {
			const reply = await rawRequest(path);
			expect({ path, status: reply.status }).toEqual({ path, status: 404 });
			expect(JSON.parse(reply.body.toString("utf8"))).toEqual({ error: `Not found: GET ${path}` });
		}

		expect((await rawRequest("/pages/files/", { method: "POST" })).status).toBe(404);
	});

	it("refuses a Host header that is not an address with 403, and a query that is not valid with 400", async () => {
		expect((await rawRequest("/pages/files/", { host: "evil.example" })).status).toBe(403);

		const unknown = await rawRequest("/pages/files/?project=nosuch");
		expect(unknown.status).toBe(400);
		expect(JSON.parse(unknown.body.toString("utf8"))).toEqual({ error: "Unknown harness project: nosuch" });

		const both = await rawRequest("/pages/files/?project=main&handle=a&conversation=1");
		expect(both.status).toBe(400);
		expect(JSON.parse(both.body.toString("utf8"))).toEqual({ error: "Give handle or conversation, not both" });
	});
});
