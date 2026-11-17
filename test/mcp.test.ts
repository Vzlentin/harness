import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type Host, runHost } from "../src/host/run.ts";
import { MAIN_PROJECT, projectDir } from "../src/protocol/projects.ts";
import { cellResults, cli, handleOf, models, requests, root, scripts, setUp, tearDown, until } from "./helpers.ts";

/** A JSON-RPC message that the fixture reads. */
const Message = Type.Object({
	id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
	method: Type.Optional(Type.String()),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const EchoArguments = Type.Object({ arguments: Type.Object({ text: Type.String() }) });

/**
 * An MCP server over Streamable HTTP with the tool `echo`. With `token`, it answers 401 to a request that does not
 * carry that bearer token.
 */
class Fixture {
	readonly server: Server;
	/** The `tools/list` requests that the fixture answered. */
	listed = 0;
	/** The `Authorization` headers of the requests, in order. */
	readonly authorizations: (string | undefined)[] = [];
	readonly #token: string | undefined;

	constructor(token?: string) {
		this.#token = token;
		this.server = createServer((request, response) => {
			void this.#answer(request).then(({ status, body }) => {
				response.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
				response.end(body === undefined ? undefined : JSON.stringify(body));
			});
		});
	}

	async listen(): Promise<string> {
		this.server.listen(0, "127.0.0.1");
		await once(this.server, "listening");
		// SAFETY: a server that listens on TCP has an address of this type.
		const { port } = this.server.address() as AddressInfo;

		return `http://127.0.0.1:${port}/mcp`;
	}

	async #answer(request: IncomingMessage): Promise<{ status: number; body?: unknown }> {
		if (request.method !== "POST" || request.url !== "/mcp") return { status: request.method === "GET" ? 405 : 404 };
		let text = "";

		for await (const chunk of request) text += String(chunk);
		this.authorizations.push(request.headers.authorization);

		if (this.#token !== undefined && request.headers.authorization !== `Bearer ${this.#token}`) {
			return { status: 401 };
		}

		const message: unknown = JSON.parse(text);

		if (!Value.Check(Message, message) || message.id === undefined) return { status: 202 };
		const { id, method, params } = message;

		if (method === "initialize") {
			const result = {
				protocolVersion: params?.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1.0.0" },
			};

			return { status: 200, body: { jsonrpc: "2.0", id, result } };
		}

		if (method === "tools/list") {
			this.listed++;

			const echo = {
				name: "echo",
				description: "Gives back the text",
				inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			};

			return { status: 200, body: { jsonrpc: "2.0", id, result: { tools: [echo] } } };
		}

		if (method === "tools/call" && Value.Check(EchoArguments, params)) {
			const result = { content: [{ type: "text", text: `echo: ${params.arguments.text}` }] };

			return { status: 200, body: { jsonrpc: "2.0", id, result } };
		}

		return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } } };
	}
}

const ECHO_SCRIPT = 'const r = await tools.mcp__fixture__echo({ text: "hi" }); return r.content[0].text;';
const SECURE_SCRIPT = 'const r = await tools.mcp__secure__echo({ text: "in" }); return r.content[0].text;';

const open = new Fixture();
const secure = new Fixture("token-1");
const warnings: string[] = [];
let secureUrl: string;
let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	const url = await open.listen();
	secureUrl = await secure.listen();

	const mcpServers = {
		fixture: { url, description: "Echoes text" },
		secure: { url: secureUrl },
		resolved: { url, headers: { "X-Token": "${TOKEN}" } },
	};

	await writeFile(join(root, "agent", "mcp.json"), JSON.stringify({ mcpServers }));
	const write = process.stderr.write.bind(process.stderr);

	vi.spyOn(process.stderr, "write").mockImplementation((chunk, ...rest) => {
		warnings.push(String(chunk));

		// SAFETY: the rest of the arguments of a write, given on as they came.
		return write(chunk, ...(rest as []));
	});

	host = await runHost({ project: MAIN_PROJECT, cwd: projectDir(MAIN_PROJECT), models });
	await until(() => open.listed > 0 && warnings.some((line) => line.includes('"secure" requires sign-in')));
});

afterAll(async () => {
	await host?.close();
	vi.restoreAllMocks();
	open.server.close();
	secure.server.close();
	await tearDown();
});

/** Runs a child whose model calls `codemode` with `code`, and gives the text of the result. */
async function runScript(prompt: string, code: string): Promise<string> {
	scripts.set(`Task:\n${prompt}`, [{ name: "codemode", arguments: { code } }]);
	await cli(["wait", handleOf(await cli(["spawn", "--prompt", prompt]))]);

	return cellResults.get(`Task:\n${prompt}`)?.[0] ?? "";
}

describe("the MCP tools of hosted conversations", { timeout: 30_000 }, () => {
	it("lets a codemode script call a tool of a server in Pi's mcp.json", async () => {
		expect(await runScript("Echo", ECHO_SCRIPT)).toContain("echo: hi");
	});

	it("does not offer MCP tools to the model, and names their servers in the system prompt", async () => {
		await runScript("Declarations", "return 1;");
		const seen = requests.get("Task:\nDeclarations");

		expect(seen?.tools).toContain("codemode");
		expect(seen?.tools.some((name) => name.startsWith("mcp__"))).toBe(false);
		expect(seen?.system).toContain("- mcp__fixture: Echoes text");
	});

	it("refuses a server whose config uses a value that Pi resolves", () => {
		expect(warnings.join("")).toContain(
			'server "resolved": headers "X-Token" uses ${VAR}, $VAR or !command, which the harness host does not resolve',
		);
	});

	it("gives Pi's sign-in message, and uses the tokens that Pi saves in mcp-auth.json", async () => {
		expect(await runScript("Sign-in needed", SECURE_SCRIPT)).toContain(
			'MCP server "secure" requires sign-in. Run /mcp to sign in.',
		);

		const state = { serverUrl: secureUrl, tokens: { access_token: "token-1", token_type: "Bearer" } };
		await writeFile(join(root, "agent", "mcp-auth.json"), JSON.stringify({ [`mcp__secure|${secureUrl}`]: state }));

		expect(await runScript("Signed in", SECURE_SCRIPT)).toContain(
			'MCP server "secure" connected while the script started. Run the script again.',
		);
		expect(await runScript("Again", SECURE_SCRIPT)).toContain("echo: in");
		expect(secure.authorizations).toContain("Bearer token-1");
	});
});
