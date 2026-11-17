/**
 * The MCP servers of the host, read as Pi's MCP extension reads them: `mcp.json` in Pi's agent directory and, when the
 * project is trusted, `.pi/mcp.json` of the project directory, whose entries replace or override the global ones.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	isMcpServerOverride,
	type McpServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../protocol/requests.ts";

/** How the tools of a server are reached: Pi's exposures. The host has no `tool_search`, so `deferred` is `codemode`. */
const Exposure = Type.Union([
	Type.Literal("codemode"),
	Type.Literal("deferred"),
	Type.Literal("direct"),
	Type.Literal("hidden"),
]);

export type McpExposure = Static<typeof Exposure>;

/** A JSON object, as a server entry and an `mcp.json` are. */
const JsonObject = Type.Record(Type.String(), Type.Unknown());

type JsonObject = Static<typeof JsonObject>;

const ConfigFile = Type.Object({ mcpServers: Type.Optional(JsonObject) });

/** The fields that Pi adds to the `mcpServers` shape of pi-mcp. */
const PiFields = Type.Object({
	exposure: Type.Optional(Exposure),
	toolExposure: Type.Optional(Type.Record(Type.String(), Exposure)),
	auth: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }) })),
});

/** The fields that a project entry with no `command`, `url` or `type` may set over the global entry. */
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/** Older exposure names that Pi still accepts. */
const EXPOSURE_ALIASES = new Map<string, McpExposure>([["codemode-deferred", "codemode"]]);

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** A value that Pi resolves as `${VAR}`, `$VAR` or `!command`, which the host does not. */
const RESOLVED_VALUE = /^!|\$/;

/** One enabled server, checked. */
export type McpServerEntry = {
	readonly name: string;
	readonly config: McpServerConfig;
	readonly exposure: McpExposure;
	readonly toolExposure: Readonly<Record<string, McpExposure>>;
	/** The provider whose `/login` token the server gets, for an HTTP server with `auth`. */
	readonly authProvider: string | undefined;
};

/** The servers of the host, and the problems of the files, one line each. */
export type McpConfig = { readonly servers: readonly McpServerEntry[]; readonly errors: readonly string[] };

type Read = { readonly raw: JsonObject; readonly entry: McpServerEntry };

/** The servers of `agentDir/mcp.json` and, when `trusted`, of `cwd/.pi/mcp.json`; disabled servers are left out. */
export function loadMcpConfig(agentDir: string, cwd: string, trusted: boolean): McpConfig {
	const servers = new Map<string, Read>();
	const errors: string[] = [];

	readFile(join(agentDir, "mcp.json"), "global", servers, errors);

	if (trusted) readFile(join(cwd, CONFIG_DIR_NAME, "mcp.json"), "project", servers, errors);

	const enabled = [...servers.values()].flatMap(({ entry }) => (entry.config.enabled === false ? [] : [entry]));

	return { servers: enabled, errors };
}

/** Exposure of the tool `tool` of `entry`: its `toolExposure` entry, exact or with `*`, else the server's exposure. */
export function toolExposure(entry: McpServerEntry, tool: string): McpExposure {
	const exact = entry.toolExposure[tool];

	if (exact !== undefined) return exact;

	for (const [pattern, exposure] of Object.entries(entry.toolExposure)) {
		if (pattern.includes("*") && toolPattern(pattern).test(tool)) return exposure;
	}

	return entry.exposure;
}

/** Exposures that the tools of `entry` can have, known before it connects. */
export function configuredExposures(entry: McpServerEntry): ReadonlySet<McpExposure> {
	return new Set([entry.exposure, ...Object.values(entry.toolExposure)]);
}

function readFile(path: string, scope: "global" | "project", servers: Map<string, Read>, errors: string[]): void {
	if (!existsSync(path)) return;
	let parsed: unknown;

	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		errors.push(`${path}: ${errorMessage(error)}`);

		return;
	}

	if (!Value.Check(ConfigFile, parsed)) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);

		return;
	}

	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		if (!Value.Check(JsonObject, value)) {
			errors.push(`${path}: server "${name}" must be an object`);

			continue;
		}

		const raw = resolveAliases(value);

		if (scope === "project" && isMcpServerOverride(raw)) {
			const base = servers.get(name);
			const extra = Object.keys(raw).filter((key) => !OVERRIDE_KEYS.includes(key));

			if (base === undefined) {
				errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
			} else if (extra.length > 0) {
				errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			} else {
				const merged = { ...base.raw, ...raw };
				const checked = checkEntry(name, merged);

				if ("error" in checked) errors.push(`${path}: ${checked.error}`);
				else servers.set(name, { raw: merged, entry: checked.entry });
			}

			continue;
		}

		const checked = checkEntry(name, raw);

		if ("error" in checked) {
			errors.push(`${path}: ${checked.error}`);

			continue;
		}

		const { entry } = checked;

		// Names that differ only in `-` and `_` would share a namespace.
		const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));

		if (clash !== undefined) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);

			continue;
		}

		if (scope === "project" && entry.authProvider !== undefined) {
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);

			continue;
		}

		servers.set(name, { raw, entry });
	}
}

/** `raw` with the exposure aliases replaced by their names. */
function resolveAliases(raw: JsonObject): JsonObject {
	const resolved: JsonObject = { ...raw };

	if (Value.Check(Type.String(), raw.exposure)) resolved.exposure = EXPOSURE_ALIASES.get(raw.exposure) ?? raw.exposure;

	if (Value.Check(JsonObject, raw.toolExposure)) {
		resolved.toolExposure = Object.fromEntries(
			Object.entries(raw.toolExposure).map(([tool, exposure]) => [
				tool,
				Value.Check(Type.String(), exposure) ? (EXPOSURE_ALIASES.get(exposure) ?? exposure) : exposure,
			]),
		);
	}

	return resolved;
}

/** The entry of the server `name`, or what is wrong with it. */
function checkEntry(name: string, raw: JsonObject): { readonly entry: McpServerEntry } | { readonly error: string } {
	const result = validateMcpServerConfig(name, raw, { checkMetadataDocumentCallback });

	if (result.kind === "invalid") return { error: result.error };
	const { config } = result;
	const url = result.kind === "http" ? new URL(result.config.url) : undefined;

	if (!Value.Check(PiFields, config)) {
		return {
			error: `server "${name}": exposure and each toolExposure must be one of "codemode", "deferred", "direct", "hidden", and auth.provider a provider name`,
		};
	}

	const auth = url === undefined ? undefined : config.auth;

	if (url !== undefined && auth !== undefined) {
		if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
			return { error: `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]` };
		}
	}

	const resolved = resolvedValue(result);

	if (resolved !== undefined) {
		return {
			error: `server "${name}": ${resolved} uses \${VAR}, $VAR or !command, which the harness host does not resolve`,
		};
	}

	const entry = {
		name,
		config,
		exposure: config.exposure ?? "codemode",
		toolExposure: config.toolExposure ?? {},
		authProvider: auth?.provider,
	};

	return { entry };
}

/** The first field of `result` whose value Pi would resolve, such as `headers "Authorization"`. */
function resolvedValue(result: Exclude<ReturnType<typeof validateMcpServerConfig>, { kind: "invalid" }>) {
	const fields: [string, string | undefined][] = [];

	if (result.kind === "http") {
		const { headers = {}, oauth } = result.config;

		for (const [header, value] of Object.entries(headers)) fields.push([`headers "${header}"`, value]);
		fields.push(["oauth.clientSecret", oauth?.clientSecret]);
	} else {
		for (const [key, value] of Object.entries(result.config.env ?? {})) fields.push([`env "${key}"`, value]);
	}

	return fields.find(([, value]) => value !== undefined && RESOLVED_VALUE.test(value))?.[0];
}

/**
 * Whether Pi's Client ID Metadata Documents list the loopback `callbackUrl`: `/callback` on localhost and 127.0.0.1, on
 * any port. Without `callbackUrl`, Pi uses such a URI.
 */
export function isClientMetadataDocumentCallback(callbackUrl: string | undefined): boolean {
	if (callbackUrl === undefined) return true;
	const url = new URL(callbackUrl);

	return url.hostname !== "[::1]" && url.pathname === "/callback";
}

function checkMetadataDocumentCallback(callbackUrl: string | undefined): string | undefined {
	return isClientMetadataDocumentCallback(callbackUrl)
		? undefined
		: 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
}

/** A tool name pattern where `*` matches any characters. */
function toolPattern(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");

	return new RegExp(`^${source}$`);
}
