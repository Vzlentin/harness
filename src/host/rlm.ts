/**
 * `rlm` in the IPython kernels of the host: a kernel server for each kernel start of a conversation that is not a leaf.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { Store } from "../children/library.ts";
import { ConversationKernelStarting, INVALID_KERNEL_STARTING, KERNEL_STARTING } from "../rlm/kernel.ts";
import { type KernelScope, KernelServers } from "../rlm/server.ts";
import { callerDefaults, type Send } from "../tool.ts";
import { library } from "./targets.ts";

const context = BACKGROUND_CONTEXT;

export type Rlm = {
	/**
	 * Closes the kernel servers. It keeps listening, so a later kernel start that is not a leaf fails with `The host is
	 * closing`. The bus closes with the entries.
	 */
	close(): Promise<void>;
};

/**
 * Serves `rlm` to the kernels that pi-ipython starts and announces on `events`. The requests of a kernel go to `send`,
 * with the conversation of the kernel as the caller, as for its `subagent` tool. `warn` gets each invalid event.
 */
export function serveRlm(
	events: EventBus,
	place: { readonly store: Pick<Store, "snapshot" | "conversation"> },
	send: Send,
	warn: (cause: unknown) => void,
): Rlm {
	const servers = new KernelServers(send);

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

	return { close: () => servers.close() };
}

/** Whether the conversation `id` is at the limit of its depth budget. A conversation without lineage is at depth 0. */
async function isLeaf(store: Pick<Store, "snapshot">, id: string, leafContext: Context): Promise<boolean> {
	const lineage = await library.lineage(store, id, leafContext);

	return lineage !== undefined && lineage.depth >= lineage.limit;
}
