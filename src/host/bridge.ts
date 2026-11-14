/**
 * The tools bridge in the IPython kernels of the host: a kernel server for each kernel start of a conversation, and the
 * tools of each running cell, as nested calls of its `ipython` call.
 */
import type { Context } from "@earendil-works/chord/context";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type {
	ConversationId,
	JsonObject,
	NestedToolExecutionResult,
	ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { CELL_END, CELL_START, KERNEL_STARTING, KernelStarting } from "../bridge/kernel.ts";
import { onValid } from "../bridge/listen.ts";
import { type CallResult, type Cell, KernelServers } from "../bridge/server.ts";

/** The payload of `KERNEL_STARTING` in the host, which also gives the conversation of the kernel. */
const ConversationKernelStarting = Type.Object({
	...KernelStarting.properties,
	conversationId: Type.Unsafe<ConversationId>(Type.Integer()),
});

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
	const warning = (message: string) => warn(new Error(message));

	onValid(events, KERNEL_STARTING, ConversationKernelStarting, warning, (starting) =>
		servers.serveStart(starting, String(starting.conversationId)),
	);
	onValid(events, CELL_START, CellStart, warning, (start) =>
		servers.open(String(start.conversationId), start.api.callId, hostCell(start)),
	);
	// The event has no call ID, and a kernel runs one cell at a time, so the oldest open cell is the one that ended.
	onValid(events, CELL_END, CellEnd, warning, (end) => servers.end(String(end.conversationId)));

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

			return resultOf(structured, result);
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
 * The raw result of a nested call. A tool without a schema gives its text as its structured output. A tool with a schema
 * keeps no text, so a failed call without text gives its error diagnostics as its text.
 */
function resultOf(structured: boolean, result: NestedToolExecutionResult): CallResult {
	const text = structured ? "" : textOf(result.structuredOutput);

	const diagnostics = result.diagnostics
		.filter((diagnostic) => diagnostic.severity === "error")
		.map((diagnostic) => diagnostic.message)
		.join("\n");

	return {
		isError: result.isError,
		text: text || (result.isError ? diagnostics : ""),
		output: structured ? result.structuredOutput : undefined,
	};
}

/** The text of the output of a tool without a schema: a string, or a list of text and image items. */
function textOf(value: NestedToolExecutionResult["structuredOutput"]): string {
	if (Value.Check(Type.String(), value)) return value;

	if (!Value.Check(Type.Array(Type.Unknown()), value)) return "";

	return value.flatMap((item) => (Value.Check(TextItem, item) ? [item.text] : [])).join("\n");
}
