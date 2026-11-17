/**
 * The tool layer of the MCP servers, as in Pi: the names of the tools of a server, the tools that scripts can call,
 * and the tool registration of each. Its output schema is the `CallToolResult` that a script gets, without `_meta`,
 * with the output schema of the tool as its `structuredContent`.
 */
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createMcpToolName, normalizeMcpInputSchema, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type McpServerEntry, toolExposure } from "./mcp-config.ts";
import type { McpServer } from "./mcp-server.ts";

/** The arguments of an MCP tool: a JSON object. */
const Arguments = Type.Record(Type.String(), Type.Unknown());

export type McpArguments = Static<typeof Arguments>;

/** A tool of a server that scripts can call: not `hidden`. */
export type NamedTool = {
	/** The name of the tool for scripts: `mcp__<server>__<tool>`. */
	readonly name: string;
	readonly tool: Tool;
	/** Whether the tool is in the `codemode` section, not only found by scripts. */
	readonly direct: boolean;
};

/** The tools of the server `entry` that scripts can call, but its `hidden` tools, named as in Pi. */
export function namedTools(entry: McpServerEntry, tools: readonly Tool[]): NamedTool[] {
	const plain = [...new Set(tools.map((tool) => tool.name))].map((tool) => createMcpToolName(entry.name, tool));
	const used = new Set<string>();

	return tools.flatMap((tool) => {
		// As in Pi, every tool whose name sanitizes to a name that another tool has gets the hash suffix.
		const name = createMcpToolName(
			entry.name,
			tool.name,
			(candidate) => used.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate),
		);

		used.add(name);
		const exposure = toolExposure(entry, tool.name);

		return exposure === "hidden" ? [] : [{ name, tool, direct: exposure === "direct" }];
	});
}

/** The registration of the tool `named` of `server`, which calls the tool on the server. */
export function mcpToolRegistration(server: McpServer, named: NamedTool): ToolRegistration {
	const { name, tool, direct } = named;
	const title = tool.title ?? tool.annotations?.title;

	const registration: ToolRegistration = {
		name,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server.name}`,
		parameters: normalizeMcpInputSchema(tool.inputSchema),
		structuredOutputSchema: mcpResultSchema(tool.outputSchema),
		// Only scripts call MCP tools: the model never gets them.
		callers: ["tools"],
		execute: async (args, _api, context) => {
			if (!Value.Check(Arguments, args)) throw new Error(`MCP tool ${name} takes an object`);
			const result = await server.callTool(tool.name, args, context.abortSignal);
			const { _meta: _ignored, ...scriptResult } = result;
			const output = toLlmContent(result);

			if (result.isError === true && output.every((block) => block.type !== "text" || block.text === "")) {
				output.push({ type: "text", text: `MCP tool ${server.name}/${tool.name} returned an error` });
			}

			const structuredOutput = copyJson(scriptResult, { omitUndefinedProperties: true });

			return result.isError === true ? { output, structuredOutput, isError: true } : { output, structuredOutput };
		},
	};

	// Direct tools are in the `codemode` section; the others only scripts find, as in Pi.
	return direct ? registration : { ...registration, deferred: true };
}

/** A reference to the schema itself or below it: `#` or `#/...`. */
const LocalReference = Type.String({ pattern: "^#(/|$)" });

/**
 * MCP content blocks as one compact type with the fields of text and image blocks, which scripts read most. It is in
 * the declaration of every MCP tool.
 */
const CONTENT_BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const SCHEMA_DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);

/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

/** The output schema of an MCP tool whose own output schema is `structuredContentSchema`. */
function mcpResultSchema(structuredContentSchema: Tool["outputSchema"]) {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
			// A server may send structured content with no schema for it, and it may be any JSON value.
			structuredContent:
				structuredContentSchema === undefined
					? {}
					: relocateSchema(copyJson(structuredContentSchema), "#/properties/structuredContent"),
			isError: { type: "boolean" },
		},
		required: ["content"],
		// The fields that newer protocol versions add.
		additionalProperties: true,
	};
}

/**
 * `schema` as a subschema at the JSON pointer `pointer` of another schema: its local references (`#`, `#/$defs/Item`)
 * point below `pointer`, so they resolve to the same subschemas as before.
 */
function relocateSchema(schema: JsonValue, pointer: string): JsonValue {
	if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));

	if (schema === null || !(schema instanceof Object)) return schema;
	const relocated: { [key: string]: JsonValue } = {};

	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && Value.Check(LocalReference, value)) {
			relocated[key] = `${pointer}${value.slice(1)}`;
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			relocated[key] = value;
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && value instanceof Object && !Array.isArray(value)) {
			relocated[key] = Object.fromEntries(
				Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
			);
		} else {
			relocated[key] = relocateSchema(value, pointer);
		}
	}

	return relocated;
}
