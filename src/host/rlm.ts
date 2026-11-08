/**
 * `rlm` in the IPython kernels of the host: a kernel server for each kernel start of a conversation that is not a leaf,
 * and the `<rlm>` section of such conversations when they have the `ipython` tool.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { type ConversationId, defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { Store } from "../children/library.ts";
import { KERNEL_STARTING, KernelStarting, STARTUP_CODE } from "../rlm/kernel.ts";
import { RLM_SECTION } from "../rlm/prompt.ts";
import { type KernelScope, KernelServers } from "../rlm/server.ts";
import { callerDefaults, type Send } from "../tool.ts";
import { library } from "./targets.ts";

const context = BACKGROUND_CONTEXT;

export type Rlm = {
	/** The extension with the `<rlm>` section, for the default selection of the conversations. */
	readonly extension: Extension;
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

	const setUp = async (starting: KernelStarting): Promise<void> => {
		const { conversationId } = starting;

		// A leaf opens no children, so its kernel gets no `rlm`.
		if (await isLeaf(place.store, String(conversationId), context)) return;
		const env = await servers.start(String(conversationId), () => scope(conversationId));
		Object.assign(starting.env, env);
		starting.startupCode.push(...STARTUP_CODE);
	};

	events.on(KERNEL_STARTING, (starting) => {
		if (!Value.Check(KernelStarting, starting)) {
			warn(new Error(`The ${KERNEL_STARTING} event has an invalid payload; its kernel gets no rlm`));

			return;
		}

		// pi-ipython reads the payload once the promises of `waitFor` settle, so the change happens in one. Its
		// rejection fails the kernel start.
		starting.waitFor(setUp(starting));
	});

	const extension = defineExtension({
		name: "harness-rlm",
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
