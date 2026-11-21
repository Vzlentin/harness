/**
 * What runs before each input of a hosted conversation, from a request or from a push: the input hooks of the entries,
 * each of which can write one passive user entry.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { Degraded } from "./degraded.ts";
import { type InputHook, InputWrite } from "./entries.ts";
import { type Found, passiveEntry } from "./targets.ts";

const context = BACKGROUND_CONTEXT;

/** What the input hooks use of the host. */
export type InputHooksHost = {
	readonly storage: Pick<Storage, "findLatestHeadMarker">;
	readonly inputHooks: readonly InputHook[];
	readonly degraded: Degraded;
};

/**
 * Runs each input hook of `host`, in load order, before an input of the conversation of `target`. A hook gets the ID
 * of the newest head marker of the context, and a `write` that writes one passive user entry with the request ID
 * `input:<hook kind>:<key>`, so a repeat after a crash adds nothing. A second write in one run, and an invalid write,
 * throw. It never throws: a hook that fails is a warning and the degraded state `catch-up-failed` of the cause
 * `input:<kind>`, which its next run that does not fail ends, and the input goes through.
 */
export async function beforeInput(host: InputHooksHost, target: Pick<Found, "conversation" | "write">): Promise<void> {
	const conversation = String(target.conversation.id);

	for (const hook of host.inputHooks) {
		await host.degraded.guard("catch-up-failed", `input:${hook.kind}`, `input: ${hook.kind}: `, async () => {
			const marker = await host.storage.findLatestHeadMarker(target.conversation.id, undefined, context);
			let written = false;

			const write = async (entry: InputWrite) => {
				if (!Value.Check(InputWrite, entry)) throw new Error(`The input hook ${hook.kind} wrote an invalid entry`);

				if (written) throw new Error(`The input hook ${hook.kind} writes at most one entry before an input`);
				written = true;
				await target.write({ type: "write", requestId: `input:${hook.kind}:${entry.key}`, entry: passiveEntry(entry) });
			};

			await hook.run({ conversation, head: marker === undefined ? undefined : String(marker.id), write });
		});
	}
}
