/**
 * The `subagent` tool for hosts that run agents on pi-durable. The host passes its pi-durable and pi-ai modules, so
 * this package loads no second copy of either.
 */
import { randomUUID } from "node:crypto";
import type * as Ai from "@earendil-works/pi-ai";
import type * as Durable from "@earendil-works/pi-durable";
import { sendToHost, subagentTool } from "./tool.ts";

/**
 * The `piDurable` entry. The caller is `<store>:<conversation ID>`, where the store is a random ID that the store keeps,
 * so conversations of two stores do not share children.
 */
export default function subagentEntry({ durable, ai }: { readonly durable: typeof Durable; readonly ai: typeof Ai }) {
	const Store = durable.defineDoc<{ id: string }>({
		kind: "pi-subagent.store",
		version: 1,
		scope: "session",
		initial: () => ({ id: "" }),
	});
	// The store ID never changes, so the first call reads it and the next calls reuse it.
	let storeId: string | undefined;
	const extension = subagentTool(durable, ai, {
		caller: async (api, context) => {
			storeId ??= await api.commit(async (tx) => {
				const store = await tx.doc(Store);
				if (store.id === "") store.id = randomUUID();
				return store.id;
			}, context);
			return `${storeId}:${api.conversationId}`;
		},
		send: sendToHost,
	});
	return { extensions: [extension], close: async () => {} };
}
