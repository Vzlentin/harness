/**
 * The tools bridge in the IPython kernels of the host: a kernel server for each kernel start of a conversation, and the
 * tools of each running cell, as nested calls of its `ipython` call.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type {
	ConversationId,
	JsonObject,
	NestedToolExecutionResult,
	ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ConversationKernelStarting } from "../bridge/kernel.ts";
import { listenBridge } from "../bridge/listen.ts";
import { type Cell, KernelServers } from "../bridge/server.ts";

/** A function, as far as a payload check reads it. */
const Callable = Type.Function([Type.Unknown()], Type.Unknown());

/** The payload of `CELL_START` in the host: the conversation of the cell, and the API and the context of its call. */
const CellStart = Type.Object({
	conversationId: Type.Unsafe<ConversationId>(Type.Integer()),
	api: Type.Unsafe<Pick<ToolExecutionApi, "callId" | "agent" | "executeTool">>(
		Type.Object({ callId: Type.String(), agent: Callable, executeTool: Callable }),
	),
	context: Type.Unsafe<Context>(Type.Object({})),
});

/** The payload of `CELL_END` in the host. It does not say which cell ended. */
const CellEnd = Type.Object({ conversationId: Type.Integer() });

/** A text item of the output of a tool without a schema. */
const TextItem = Type.Object({ type: Type.Literal("text"), text: Type.String() });

export type Bridge = {
	/**
	 * Closes the kernel servers. It keeps listening, so a later kernel start fails with `The host is closing`. The bus
	 * closes with the entries.
	 */
	close(): Promise<void>;
};

/**
 * Serves the tools bridge to the kernels and the cells that pi-ipython announces on `events`. A call of a cell runs as
 * a nested call of the `ipython` call of the oldest open cell of its conversation. `warn` gets each invalid event.
 */
export function serveBridge(events: EventBus, warn: (cause: unknown) => void): Bridge {
	const servers = new KernelServers();

	listenBridge(events, {
		kernelStarting: ConversationKernelStarting,
		cellStart: CellStart,
		cellEnd: CellEnd,
		servers: () => servers,
		kernel: (starting) => ({ key: String(starting.conversationId), starting }),
		cell: (start) => ({ key: String(start.conversationId), id: start.api.callId, cell: hostCell(start) }),
		// The event has no call ID, and a kernel runs one cell at a time, so the oldest open cell is the one that ended.
		ended: (end) => ({ key: String(end.conversationId) }),
		warn: (message) => warn(new Error(message)),
	});

	return { close: () => servers.close() };
}

/**
 * The cell of `start`. Its calls are nested calls of the cell's call, so pi-durable checks their arguments and gates
 * them, and aborts those that still run when the cell ends.
 */
function hostCell({ api, context }: Static<typeof CellStart>): Cell {
	return {
		async call({ name, structured }, args) {
			// SAFETY: the same JSON object; pi-durable's type has mutable arrays, and the nested call does not change them.
			const result = await api.executeTool(name, args as JsonObject, context);

			return valueOf(name, structured, result);
		},
		tools: async () =>
			(await api.agent(context)).callable.map(
				({ name, description, parameters, structuredOutputSchema, deferred }) => ({
					name,
					description,
					parameters,
					structured: structuredOutputSchema !== undefined,
					deferred,
				}),
			),
	};
}

/**
 * What a cell gets for the nested call of the tool `name`: its structured output when the tool has a schema for it,
 * else its text. A failed call throws with the tool's text, else its error diagnostics.
 */
function valueOf(name: string, structured: boolean, result: NestedToolExecutionResult): JsonValue {
	const text = structured ? "" : textOf(result.structuredOutput);

	// A tool with a schema whose call gave no structured output gives null, as its output is not kept.
	if (!result.isError) return structured ? (result.structuredOutput ?? null) : text;

	const diagnostics = result.diagnostics
		.filter((diagnostic) => diagnostic.severity === "error")
		.map((diagnostic) => diagnostic.message)
		.join("\n");

	throw new Error(text || diagnostics || `Tool ${name} failed`);
}

/** The text of the output of a tool without a schema: a string, or a list of text and image items. */
function textOf(value: NestedToolExecutionResult["structuredOutput"]): string {
	if (Value.Check(Type.String(), value)) return value;

	if (!Value.Check(Type.Array(Type.Unknown()), value)) return "";

	return value.flatMap((item) => (Value.Check(TextItem, item) ? [item.text] : [])).join("\n");
}
