/**
 * The connection to one configured MCP server, as Pi's `McpServerConnection`: its state, the connect with retries, the
 * transport, a new session when the server forgot one, and the sign-in that the server needs.
 */
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Models } from "@earendil-works/pi-ai/models";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	type CallToolResult,
	McpAuthRequiredError,
	McpClient,
	McpHttpError,
	McpSessionExpiredError,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { type McpAuthProvider, McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { errorMessage } from "../protocol/requests.ts";
import { mcpAuth } from "./mcp-auth.ts";
import type { McpServerEntry } from "./mcp-config.ts";
import { type McpArguments, type NamedTool, namedTools } from "./mcp-tools.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2000;

/** The waits before the next attempts to connect to an HTTP server that failed with a transient error. */
const CONNECT_RETRY_DELAYS_MS = [250, 1000];

type State = "connecting" | "connected" | "needs-auth" | "failed" | "closed";

/** One configured server. It connects again when a call finds the connection gone. */
export class McpServer {
	readonly entry: McpServerEntry;
	state: State = "connecting";
	/** Why the server needs sign-in or failed, for a script that names it. */
	problem: string | undefined;
	/** The instructions of the server from `initialize`. */
	instructions: string | undefined;
	readonly #options: ServerOptions;
	readonly #auth: McpAuthProvider | undefined;
	/** Aborted by `close()`; stops a connect in progress, the waits between its attempts too. */
	readonly #shutdown = new AbortController();
	#client: McpClient | undefined;
	#opening: Promise<McpClient> | undefined;
	/** The named tools of the last tool list of the server. */
	#tools: readonly NamedTool[] = [];

	constructor(entry: McpServerEntry, options: ServerOptions) {
		this.entry = entry;
		this.#options = options;
		this.#auth = mcpAuth(entry, options.agentDir, options.models);
	}

	get name(): string {
		return this.entry.name;
	}

	get #timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** The client, connected now if there is none. */
	client(): Promise<McpClient> {
		if (this.#shutdown.signal.aborted) return Promise.reject(new Error(`MCP server "${this.name}" is shut down`));

		if (this.#client?.connectionState === "connected") return Promise.resolve(this.#client);

		this.#opening ??= this.#open().finally(() => {
			this.#opening = undefined;
		});

		return this.#opening;
	}

	/**
	 * Waits for the connect in progress. With `retry`, a server that needs sign-in or failed tries once more, so a sign-in
	 * done in Pi applies with no restart of the host.
	 */
	async ready(retry: boolean): Promise<void> {
		if (retry && (this.state === "needs-auth" || this.state === "failed")) {
			await this.client().catch(() => undefined);
		} else {
			await this.#opening?.catch(() => undefined);
		}
	}

	/** The tools of the server that scripts can call; none when it is not connected. */
	get tools(): readonly NamedTool[] {
		return this.state === "connected" ? this.#tools : [];
	}

	/** Calls the tool `tool`; a session that the server forgot gets a new one, once. */
	async callTool(tool: string, args: McpArguments, signal: AbortSignal | undefined): Promise<CallToolResult> {
		for (let attempt = 1; ; attempt++) {
			const client = await this.client();

			try {
				const options = signal === undefined ? { timeoutMs: this.#timeoutMs } : { timeoutMs: this.#timeoutMs, signal };

				return await client.callTool(tool, args, options);
			} catch (error) {
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					if (this.#client === client) this.#client = undefined;

					continue;
				}

				if (!this.#needsSignIn(error)) throw error;
				await this.#drop(client);
				this.#markNeedsAuth();
				throw new Error(this.problem);
			}
		}
	}

	async #open(): Promise<McpClient> {
		this.state = "connecting";
		const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];

		for (let attempt = 0; ; attempt++) {
			try {
				return await this.#connectOnce();
			} catch (error) {
				const delay = retries[attempt];
				const closed = () => this.#shutdown.signal.aborted;

				if (closed() || delay === undefined || !isTransient(error)) throw this.#connectFailed(error);
				await sleep(delay, undefined, { signal: this.#shutdown.signal }).catch(() => undefined);

				if (closed()) throw this.#connectFailed(error);
			}
		}
	}

	async #connectOnce(): Promise<McpClient> {
		const { cwd } = this.#options;

		const client = new McpClient({
			name: "pi",
			version: VERSION,
			requestTimeoutMs: this.#timeoutMs,
			roots: [{ uri: pathToFileURL(cwd).href, name: basename(cwd) }],
		});

		let closing: Promise<void> | undefined;
		const closeClient = () => (closing ??= client.close().catch(() => undefined));
		this.#shutdown.signal.addEventListener("abort", closeClient, { once: true });
		const transport = this.#transport();

		try {
			await client.connect(transport);
			client.onNotification("notifications/tools/list_changed", () => void this.#refreshTools(client));

			client.onClose(() => {
				if (this.#client === client) this.#client = undefined;
			});

			// A server without the tools capability does not answer `tools/list`.
			const tools = client.serverCapabilities?.tools === undefined ? [] : await client.listTools();

			if (this.#shutdown.signal.aborted) throw new Error("shut down while connecting");

			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.#client = client;
			this.#tools = namedTools(this.entry, tools);
			this.instructions = client.instructions?.trim() || undefined;
			this.state = "connected";
			this.problem = undefined;
			this.#options.onChange();

			return client;
		} catch (error) {
			await closeClient();
			const stderr = transport instanceof StdioTransport ? transport.stderr.trim().slice(-STDERR_TAIL_CHARS) : "";

			throw stderr === "" ? error : new Error(`${errorMessage(error)}\n${stderr}`, { cause: error });
		} finally {
			this.#shutdown.signal.removeEventListener("abort", closeClient);
		}
	}

	#transport(): StdioTransport | StreamableHttpTransport {
		const { config } = this.entry;

		if ("url" in config) {
			const headers = config.headers ?? {};

			return new StreamableHttpTransport(
				this.#auth === undefined
					? { url: config.url, headers }
					: { url: config.url, headers, authProvider: this.#auth },
			);
		}

		return new StdioTransport({
			command: expandHome(config.command),
			args: (config.args ?? []).map(expandHome),
			cwd: resolve(this.#options.cwd, expandHome(config.cwd ?? ".")),
			env: config.env ?? {},
			stderr: "pipe",
		});
	}

	#connectFailed(cause: unknown): Error {
		if (this.#shutdown.signal.aborted) {
			this.state = "closed";

			return new Error(`MCP server "${this.name}" is shut down`);
		}

		if (this.#needsSignIn(cause)) {
			this.#markNeedsAuth();

			return new Error(this.problem);
		}

		this.state = "failed";
		this.problem = `MCP server "${this.name}" failed to connect: ${errorMessage(cause)}`;
		this.#changed();

		return new Error(this.problem);
	}

	/** Whether the user must sign in again: an OAuth server that still refuses after a refresh. */
	#needsSignIn(cause: unknown): boolean {
		return (
			cause instanceof McpOAuthAuthorizationRequiredError ||
			(this.#auth !== undefined && cause instanceof McpAuthRequiredError)
		);
	}

	#markNeedsAuth(): void {
		const provider = this.entry.authProvider;
		this.state = "needs-auth";
		this.problem = `MCP server "${this.name}" requires sign-in. Run ${provider === undefined ? "/mcp" : `/login ${provider}`} to sign in.`;
		this.#changed();
	}

	/** Writes the problem of the server to `host.log`, and gives the extensions without its tools. */
	#changed(): void {
		if (this.problem !== undefined) this.#options.warn(this.problem);
		this.#options.onChange();
	}

	async #drop(client: McpClient): Promise<void> {
		if (this.#client === client) this.#client = undefined;
		await client.close().catch(() => undefined);
	}

	async #refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();

			if (this.#client !== client || this.#shutdown.signal.aborted) return;
			this.#tools = namedTools(this.entry, tools);
			this.#options.onChange();
		} catch (error) {
			this.#options.warn(`MCP server "${this.name}" failed to refresh its tools: ${errorMessage(error)}`);
		}
	}

	/** Resolves once no transport of the server is open, and the refreshes of its tokens are saved. */
	async close(): Promise<void> {
		this.#shutdown.abort();
		this.state = "closed";
		const client = this.#client;
		this.#client = undefined;
		await Promise.all([client?.close().catch(() => undefined), this.#opening?.catch(() => undefined)]);
		await this.#auth?.settled();
	}
}

export type ServerOptions = {
	readonly cwd: string;
	readonly agentDir: string;
	readonly models: Models;
	readonly warn: (cause: unknown) => void;
	readonly onChange: () => void;
};

/** Network failures and servers that are overloaded or restart, which are worth another attempt. */
function isTransient(cause: unknown): boolean {
	if (cause instanceof McpHttpError) {
		return cause.status === 408 || cause.status === 429 || (cause.status >= 500 && cause.status !== 501);
	}

	return cause instanceof TypeError;
}

/** `~` and `~/…` name the home directory, as in a shell. */
function expandHome(value: string): string {
	if (value === "~") return homedir();

	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}
