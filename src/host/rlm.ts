/**
 * `rlm` in the IPython kernels of the host: a kernel server for each kernel start of a conversation that is not a leaf,
 * the `<rlm>` section of such conversations when they have the `ipython` tool, and the pool of the model requests of
 * the RLM children.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	type ConversationId,
	defineExtension,
	type Extension,
	GenerationTask,
	hook,
	section,
} from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { Store } from "../children/library.ts";
import { ConversationKernelStarting, INVALID_KERNEL_STARTING, KERNEL_STARTING } from "../rlm/kernel.ts";
import { POOL_SIZE } from "../rlm/limits.ts";
import { RequestPool } from "../rlm/pool.ts";
import { RLM_SECTION } from "../rlm/prompt.ts";
import { type KernelScope, KernelServers } from "../rlm/server.ts";
import { callerDefaults, type Send } from "../tool.ts";
import { ChildRecords, isRlmChild } from "./records.ts";
import { library } from "./targets.ts";

const context = BACKGROUND_CONTEXT;

export type Rlm = {
	/**
	 * The extension with the `<rlm>` section and the hooks of the pool, for the default selection of the conversations.
	 */
	readonly extension: Extension;
	/**
	 * Closes the kernel servers. It keeps listening, so a later kernel start that is not a leaf fails with `The host is
	 * closing`. The bus closes with the entries.
	 */
	close(): Promise<void>;
};

/**
 * Serves `rlm` to the kernels that pi-ipython starts and announces on `events`. The requests of a kernel go to `send`,
 * with the conversation of the kernel as the caller, as for its `subagent` tool. `warn` gets each invalid event. Each
 * model request of an RLM child takes a slot of the pool of its tree, from its start to its response, its failure or
 * its abort.
 */
export function serveRlm(
	events: EventBus,
	place: { readonly store: Pick<Store, "snapshot" | "conversation"> },
	send: Send,
	warn: (cause: unknown) => void,
): Rlm {
	const servers = new KernelServers(send);
	const pool = new RequestPool(POOL_SIZE);
	/** The release of the slot that each model request holds, by the abort signal of its invocation. */
	const slots = new WeakMap<AbortSignal, () => void>();

	const scope = async (id: ConversationId): Promise<KernelScope> => {
		const conversation = await place.store.conversation(id, context);

		if (conversation === undefined) throw new Error(`Unknown conversation: ${id}`);

		return { caller: String(id), ...callerDefaults(await conversation.agent(context)) };
	};

	const setUp = async (starting: ConversationKernelStarting): Promise<void> => {
		const { conversationId } = starting;

		// A leaf opens no children, so its kernel gets no `rlm`.
		if (await isLeaf(place.store, String(conversationId), context)) return;
		await servers.serve(starting, String(conversationId), () => scope(conversationId));
	};

	events.on(KERNEL_STARTING, (starting) => {
		if (!Value.Check(ConversationKernelStarting, starting)) {
			warn(new Error(INVALID_KERNEL_STARTING));

			return;
		}

		// pi-ipython reads the payload once the promises of `waitFor` settle, so the change happens in one. Its
		// rejection fails the kernel start.
		starting.waitFor(setUp(starting));
	});

	const poolHooks = hook(GenerationTask, {
		// An RLM child waits for a slot of its tree before each model request. One invocation runs one request, and
		// pi-durable gives the same context, with the signal of the invocation, to both hooks of the request. The response
		// frees the slot, and the end of the invocation aborts the signal, which frees it too, such as after a failure or
		// an abort.
		beforeRequest: async (_request, api, hookContext) => {
			if (!isRlmChild(await api.snapshot(ChildRecords, hookContext), api.conversationId)) return undefined;
			const { abortSignal } = hookContext;

			if (abortSignal === undefined) throw new Error("The model request of an RLM child has no abort signal");
			const lineage = await library.lineage(api, String(api.conversationId), hookContext);

			if (lineage === undefined) return undefined;
			slots.set(abortSignal, await pool.acquire(lineage.root, lineage.depth, abortSignal));

			return undefined;
		},
		afterResponse: (_message, _api, hookContext) => {
			if (hookContext.abortSignal !== undefined) slots.get(hookContext.abortSignal)?.();
		},
	});

	const extension = defineExtension({
		name: "harness-rlm",
		hooks: [poolHooks],
		sections: [
			section("rlm", async (input, renderContext) => {
				if (!input.agent.tools.some(({ name }) => name === "ipython")) return undefined;

				return (await isLeaf(input.read, String(input.conversationId), renderContext)) ? undefined : RLM_SECTION;
			}),
		],
	});

	return { extension, close: () => servers.close() };
}

/** Whether the conversation `id` is at the limit of its depth budget. A conversation without lineage is at depth 0. */
async function isLeaf(store: Pick<Store, "snapshot">, id: string, leafContext: Context): Promise<boolean> {
	const lineage = await library.lineage(store, id, leafContext);

	return lineage !== undefined && lineage.depth >= lineage.limit;
}
