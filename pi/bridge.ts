/**
 * The tools bridge in the IPython kernels of interactive Pi: a kernel server for each kernel start that pi-ipython
 * announces on `pi.events`, and the tools of each running cell, through the tool context of its call.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { Cell, KernelServers } from "../dist/bridge/index.js";
import type { Harness } from "./index.ts";

/** The key of the kernel server: pi-ipython runs one kernel for each Pi session, so a new start replaces the server. */
const KERNEL = "session";

/** The payload of `ipython:cell-start` in Pi: the ID of the cell's call, and its tool context. */
const CellStart = Type.Object({
	toolCallId: Type.String(),
	ctx: Type.Unsafe<Pick<ExtensionToolContext, "tools" | "executeTool">>(
		Type.Object({
			tools: Type.Array(Type.Object({ name: Type.String(), description: Type.String(), parameters: Type.Object({}) })),
			executeTool: Type.Function([Type.Unknown()], Type.Unknown()),
		}),
	),
});

/** The payload of `ipython:cell-end` in Pi. */
const CellEnd = Type.Object({ toolCallId: Type.String() });

/** Serves the tools bridge to the kernels and the cells of the session. */
export function registerBridge(pi: ExtensionAPI, harness: Pick<Harness, "bridge">): void {
	const { bridge } = harness;
	/** The session and its kernel servers, from its start to its end. */
	let session: { readonly ctx: ExtensionContext; readonly servers: KernelServers } | undefined;

	pi.on("session_start", (_event, ctx) => {
		session = { ctx, servers: new bridge.KernelServers() };
	});

	// A write to stderr would break the TUI, so an invalid payload gives a notification.
	const warn = (message: string) => session?.ctx.ui.notify(message, "warning");

	bridge.onValid(pi.events, bridge.KERNEL_STARTING, bridge.KernelStarting, warn, (starting) =>
		session?.servers.serveStart(starting, KERNEL),
	);
	bridge.onValid(pi.events, bridge.CELL_START, CellStart, warn, (start) =>
		session?.servers.open(KERNEL, start.toolCallId, piCell(start)),
	);
	bridge.onValid(pi.events, bridge.CELL_END, CellEnd, warn, (end) => session?.servers.end(KERNEL, end.toolCallId));

	pi.on("session_shutdown", async () => {
		const closing = session;
		session = undefined;
		await closing?.servers.close();
	});
}

/**
 * The cell of `start`. Its calls are nested calls of the cell's call, so Pi checks their arguments and runs the hooks of
 * the session on them, and aborts them when the request stops.
 */
function piCell({ ctx }: Static<typeof CellStart>): Cell {
	return {
		async call({ name }, args, signal) {
			const { result, isError } = await ctx.executeTool(name, args, { signal });
			const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");

			return { isError, text, output: result.structuredContent };
		},
		tools: async () =>
			ctx.tools.map(({ name, description, parameters, outputSchema }) => ({
				name,
				description,
				parameters,
				structured: outputSchema !== undefined,
			})),
	};
}
