/**
 * The MCP servers of the host and their tools, which codemode scripts of hosted conversations call as
 * `tools.mcp__<server>__<tool>`, as in Pi. The servers connect in the background when the host starts. A script that
 * names a server waits for its connection, and one that names a server that needs sign-in or failed tries to connect
 * it once more. The tool list of a script is fixed when its call starts, so a script whose server connected during the
 * wait fails and asks to run it again.
 */
import type { Models } from "@earendil-works/pi-ai/models";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import {
	defineExtension,
	type Extension,
	type Registry,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	CODEMODE_TOOL_NAME,
	type CodemodeNamespace,
	createCodemodeExtension,
} from "@earendil-works/pi-durable/codemode";
import { mcpNamespace } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { configuredExposures, loadMcpConfig } from "./mcp-config.ts";
import { McpServer } from "./mcp-server.ts";
import { mcpToolRegistration } from "./mcp-tools.ts";

const MCP_EXTENSION = "harness-mcp";

/** Characters of the summary of a server in the `mcp_servers` section. */
const MAX_SUMMARY_CHARS = 250;

/** Script globals that list or look up tools, so a script that uses one may call any tool. */
const DISCOVERY_GLOBALS = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;

/** The MCP servers of the host, their connections, and the extensions that give their tools. */
export class HostMcp {
	readonly #servers: readonly McpServer[];
	readonly #registry: Registry;
	readonly #sandbox: CodemodeSandboxBase;
	#extension: Extension;
	#codemode: Codemode;

	constructor(options: {
		readonly registry: Registry;
		readonly sandbox: CodemodeSandboxBase;
		readonly agentDir: string;
		readonly cwd: string;
		readonly trusted: boolean;
		readonly models: Models;
		readonly warn: (cause: unknown) => void;
	}) {
		const { registry, sandbox, agentDir, cwd, trusted, models, warn } = options;
		const { servers, errors } = loadMcpConfig(agentDir, cwd, trusted);

		for (const error of errors) warn(`MCP config: ${error}`);
		this.#registry = registry;
		this.#sandbox = sandbox;
		this.#servers = servers.map(
			(entry) => new McpServer(entry, { cwd, agentDir, models, warn, onChange: () => this.#publish() }),
		);
		this.#codemode = nextCodemode(undefined, sandbox, this.#namespaceList());
		this.#extension = this.#mcpExtension();
	}

	/** The `codemode` extension, with a namespace for each server, and the extension of the MCP tools. */
	get extensions(): readonly Extension[] {
		return [this.#codemode.extension, this.#extension];
	}

	/** Connects the servers in the background. Call it once the extensions are installed. */
	start(): void {
		for (const server of this.#servers) void server.client().catch(() => undefined);
	}

	/** Closes the connections, and waits until the refreshes of their tokens are saved. */
	async close(): Promise<void> {
		await Promise.all(this.#servers.map((server) => server.close()));
	}

	/** Installs the extensions again with the current tools; `codemode` only when its namespaces changed. */
	#publish(): void {
		const codemode = nextCodemode(this.#codemode, this.#sandbox, this.#namespaceList());

		if (codemode !== this.#codemode) {
			this.#codemode = codemode;
			this.#registry.install(codemode.extension);
		}

		this.#extension = this.#mcpExtension();
		this.#registry.install(this.#extension);
	}

	#namespaceList(): CodemodeNamespace[] {
		return this.#servers.map((server) => {
			const namespace = mcpNamespace(server.name);
			const description = server.entry.config.description?.trim();
			const listed: CodemodeNamespace = { name: namespace, prefix: `${namespace}__` };
			const described = description === undefined || description === "" ? listed : { ...listed, description };

			return server.instructions === undefined ? described : { ...described, instructions: server.instructions };
		});
	}

	#mcpExtension(): Extension {
		return defineExtension({
			name: MCP_EXTENSION,
			tools: this.#servers.flatMap((server) => server.tools.map((tool) => mcpToolRegistration(server, tool))),
			sections: [section("mcp_servers", () => serversSection(this.#servers))],
			wraps: [{ tool: CODEMODE_TOOL_NAME, wrap: (codemode: ToolRegistration) => this.#waitingCodemode(codemode) }],
		});
	}

	/** `codemode`, which first waits for the servers that the script names, as Pi does. */
	#waitingCodemode(codemode: ToolRegistration): ToolRegistration {
		return {
			...codemode,
			execute: async (args, api, context) => {
				const code = Value.Check(Type.Object({ code: Type.String() }), args) ? args.code : "";
				const all = DISCOVERY_GLOBALS.test(code);
				const words = code.match(/\w+/g) ?? [];

				const reached = this.#servers.filter(
					(server) => all || words.some((word) => word.includes(mcpNamespace(server.name))),
				);

				await Promise.all(reached.map((server) => server.ready(!all)));
				// The tools of the script are those of the phase that started the call.
				const known = new Set(api.registry.extension(MCP_EXTENSION)?.tools?.map((tool) => tool.name) ?? []);
				const late = reached.filter((server) => server.tools.some((tool) => !known.has(tool.name)));

				if (late.length > 0) {
					const names = late.map((server) => `"${server.name}"`).join(", ");

					throw new Error(`MCP server ${names} connected while the script started. Run the script again.`);
				}

				const unavailable = all ? [] : reached.filter((server) => server.problem !== undefined);

				if (unavailable.length > 0) throw new Error(unavailable.map((server) => server.problem).join("\n"));

				return codemode.execute(args, api, context);
			},
		};
	}
}

/** The `codemode` extension and the JSON of its namespaces. */
type Codemode = { readonly key: string; readonly extension: Extension };

/** `current` when its namespaces are `namespaces`, else a new `codemode` extension for them. */
function nextCodemode(
	current: Codemode | undefined,
	sandbox: CodemodeSandboxBase,
	namespaces: CodemodeNamespace[],
): Codemode {
	const key = JSON.stringify(namespaces);

	return key === current?.key ? current : { key, extension: createCodemodeExtension({ sandbox, namespaces }) };
}

/**
 * The `mcp_servers` section: the servers whose tools only scripts find, with a line of their description or
 * instructions. The model learns of the servers from it, as the `codemode` section leaves their tools out.
 */
function serversSection(servers: readonly McpServer[]): string | undefined {
	const listed = servers
		.filter((server) => {
			const exposures = configuredExposures(server.entry);

			return exposures.has("codemode") || exposures.has("deferred");
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	if (listed.length === 0) return undefined;

	const lines = listed.map((server) => {
		const text = server.entry.config.description?.trim() || server.instructions || "";
		const first = (text.split("\n", 1)[0] ?? "").trim();
		const summary = first.length > MAX_SUMMARY_CHARS ? `${first.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : first;
		const head = `- ${mcpNamespace(server.name)}`;

		return summary === "" ? head : `${head}: ${summary}`;
	});

	return [
		"MCP servers whose tools are not declared to you. Call their tools from codemode scripts, which find them with searchTools() and describeNamespace().",
		...lines,
	].join("\n");
}
