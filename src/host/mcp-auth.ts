/**
 * The credentials of the MCP servers, kept as Pi keeps them so that Pi and the host share one sign-in: the OAuth state
 * of each server in `mcp-auth.json` of Pi's agent directory under Pi's file lock, and Pi's refresh lock for each
 * server. The host never signs in: a server that needs it gets Pi's sign-in message.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { mcpNamespace } from "@earendil-works/pi-mcp";
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthServerStore,
	type McpOAuthSettings,
	type McpOAuthState,
	McpRefreshLockBusyError,
} from "@earendil-works/pi-mcp/oauth";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isClientMetadataDocumentCallback, type McpServerEntry } from "./mcp-config.ts";

/** A refresh lock that its holder stopped renewing (the process was killed) is taken over after this. */
const REFRESH_LOCK_STALE_MS = 20_000;

/** How long to wait for the refresh of another process: longer than a stale lock lives. */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;

/** Pi's tries to take the lock of `mcp-auth.json`, and the wait between them. */
const FILE_LOCK_ATTEMPTS = 10;
const FILE_LOCK_DELAY_MS = 20;

/** Pi's client identity for refreshes, so a refresh uses the client that Pi signed in with. */
const PI_CLIENT = {
	clientName: "pi",
	clientMetadataDocuments: { baseUrl: "https://pi.dev/oauth", listsRedirectUrl: isClientMetadataDocumentCallback },
};

/** The states of `mcp-auth.json`, by key. */
const States = Type.Record(Type.String(), Type.Unknown());

type States = Record<string, McpOAuthState>;

/** The auth of the server `entry`: its OAuth tokens, the token of its `/login` provider, or none. */
export function mcpAuth(entry: McpServerEntry, agentDir: string, models: Models): McpAuthProvider | undefined {
	const { config } = entry;

	if (!("url" in config)) return undefined;
	const provider = entry.authProvider;

	if (provider !== undefined) {
		// Read at each request, so the refreshes of the provider apply.
		const token = async () => (await models.getAuth(provider).catch(() => undefined))?.auth.apiKey;

		return { token, settled: async () => undefined };
	}

	if (Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization")) return undefined;

	return createMcpAuthProvider({
		...PI_CLIENT,
		serverUrl: config.url,
		store: serverStore(agentDir, entry.name, config.url),
		settings: () => oauthSettings(entry),
		// The host never signs in: a challenge only fails the connect.
		onChallenge: () => undefined,
	});
}

/** The client settings of the `oauth` field of `entry`. */
function oauthSettings(entry: McpServerEntry): McpOAuthSettings {
	const oauth = "url" in entry.config ? entry.config.oauth : undefined;

	if (oauth === undefined) return {};
	const { authServerMetadataUrl, ...settings } = oauth;

	return authServerMetadataUrl === undefined
		? settings
		: { ...settings, authServerMetadataUrl: new URL(authServerMetadataUrl) };
}

/**
 * The state of the server `name` at `serverUrl` in `agentDir/mcp-auth.json`, under the key that Pi gives it. The first
 * server that loads a state under the older key, the URL alone, takes it over, as in Pi.
 */
function serverStore(agentDir: string, name: string, serverUrl: string): McpOAuthServerStore {
	const path = join(agentDir, "mcp-auth.json");
	const legacyKey = String(new URL(serverUrl));
	const key = `${mcpNamespace(name)}|${legacyKey}`;

	return {
		load: () =>
			withFileLock(path, (states) => {
				if (states[key] !== undefined || states[legacyKey] === undefined) return { result: states[key] };
				states[key] = states[legacyKey];
				delete states[legacyKey];

				return { result: states[key], changed: true };
			}),
		save: (state) =>
			withFileLock(path, (states) => {
				states[key] = state;

				return { result: undefined, changed: true };
			}),
		withRefreshLock: (fn) => withRefreshLock(agentDir, key, fn),
	};
}

/** Runs `change` on the states of `path` under Pi's lock of the file, and writes them when it changed them. */
function withFileLock<T>(path: string, change: (states: States) => { result: T; changed?: true }): T {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });

	if (!existsSync(path)) writeFileSync(path, "{}", { encoding: "utf-8", mode: 0o600 });
	const release = lockFile(path);

	try {
		const states = parseStates(readFileSync(path, "utf-8"));
		const { result, changed } = change(states);

		if (changed) writeFileSync(path, `${JSON.stringify(states, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });

		return result;
	} finally {
		release();
	}
}

/** Takes the lock of `path` as Pi does: 10 tries, 20 ms apart, waited synchronously. */
function lockFile(path: string): () => void {
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(path);
		} catch (error) {
			if (!isLocked(error) || attempt === FILE_LOCK_ATTEMPTS) throw error;
			const start = Date.now();

			while (Date.now() - start < FILE_LOCK_DELAY_MS) {
				// Pi waits synchronously too, so its callers stay synchronous.
			}
		}
	}
}

function parseStates(content: string): States {
	if (content.trim() === "") return {};
	const parsed: unknown = JSON.parse(content);

	// SAFETY: as in Pi, the states are kept as they are, so a write keeps the states of the other servers; pi-mcp
	// checks the URL of a state before it uses it.
	return Value.Check(States, parsed) ? (parsed as States) : {};
}

/**
 * Runs `fn` while no other process refreshes the tokens of `key`, with Pi's lock file for it. Throws
 * `McpRefreshLockBusyError` when another process holds the lock for the whole wait.
 */
async function withRefreshLock<T>(agentDir: string, key: string, fn: () => Promise<T>): Promise<T> {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);

	const release = await lockfile
		.lock(join(agentDir, `mcp-auth-refresh-${hash}`), {
			realpath: false,
			stale: REFRESH_LOCK_STALE_MS,
			retries: {
				retries: REFRESH_LOCK_WAIT_MS / REFRESH_LOCK_RETRY_MS,
				factor: 1,
				minTimeout: REFRESH_LOCK_RETRY_MS,
				maxTimeout: REFRESH_LOCK_RETRY_MS,
			},
			// The default throws from a timer. A lost lock at worst lets two refreshes overlap.
			onCompromised: () => undefined,
		})
		.catch((cause: unknown) => {
			if (isLocked(cause)) throw new McpRefreshLockBusyError();
			throw cause;
		});

	try {
		return await fn();
	} finally {
		await release().catch(() => undefined);
	}
}

/** Whether `cause` is proper-lockfile's error for a lock that another process holds. */
function isLocked(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ELOCKED";
}
