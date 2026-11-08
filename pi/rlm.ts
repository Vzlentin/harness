/**
 * `rlm` in the IPython kernels of interactive Pi: a kernel server for each kernel start that pi-ipython announces on
 * `pi.events`, and the `<rlm>` section when the session has the `ipython` tool. The kernel stays in Pi, and its
 * requests go to the host of the project, which runs the children.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { KernelScope, KernelServers } from "../dist/rlm/index.js";
import type { Harness } from "./index.ts";

/** The key of the kernel server: pi-ipython runs one kernel for each Pi session, so a new start replaces the server. */
const KERNEL = "session";

/**
 * Serves `rlm` to the kernels of the session. `scope` gives the caller and the spawn defaults of the session of a
 * context, at each request. The requests start the host when none runs.
 */
export function registerRlm(
	pi: ExtensionAPI,
	harness: Pick<Harness, "rlm" | "tool">,
	scope: (pi: ExtensionAPI, ctx: ExtensionContext) => KernelScope,
): void {
	const { rlm, tool } = harness;
	/**
	 * The session and its kernel servers, from its start to its end. The getters of the context read the values at each
	 * call, such as the model after a change.
	 */
	let session: { readonly ctx: ExtensionContext; readonly servers: KernelServers } | undefined;

	pi.on("session_start", (_event, ctx) => {
		session = { ctx, servers: new rlm.KernelServers(tool.sendToHost) };
	});

	pi.events.on(rlm.KERNEL_STARTING, (starting) => {
		if (session === undefined) return;
		const { ctx, servers } = session;

		if (!Value.Check(rlm.KernelStarting, starting)) {
			// A write to stderr would break the TUI.
			ctx.ui.notify(rlm.INVALID_KERNEL_STARTING, "warning");

			return;
		}

		// pi-ipython reads the payload once the promises of `waitFor` settle, so the change happens in one. Its rejection
		// fails the kernel start.
		starting.waitFor(servers.serve(starting, KERNEL, async () => scope(pi, ctx)));
	});

	// A Pi session is a root, at depth 0, so it is never a leaf: its kernel always has `rlm`.
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;

		if (options.selectedTools.includes("ipython")) options.sections.rlm = rlm.RLM_SECTION;
	});

	// The children stay in the host.
	pi.on("session_shutdown", async () => {
		const closing = session;
		session = undefined;
		await closing?.servers.close();
	});
}
