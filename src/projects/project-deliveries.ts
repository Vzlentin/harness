/**
 * The pending deliveries of the project store: the tell of an approved held action, which waits in `project.sqlite`
 * until the host took it once, so a crash between the approve and the tell loses none.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { EntryHandles, UnknownDeliveryTarget } from "../host/entries.ts";
import { approvedText } from "../protocol/gate.ts";
import type { HeldAction } from "../protocol/project.ts";
import { errorMessage } from "../protocol/requests.ts";
import type { PendingDelivery, ProjectStore } from "./project-store.ts";

const APPROVE = "approve:";

/** The error of `deliver` for a target that is not a conversation or a Pi session of the host. */
const UnknownTarget = Type.Object({ name: Type.Literal<UnknownDeliveryTarget["name"]>("UnknownDeliveryTarget") });

/** The key of the delivery of the approve of the held action `id`. */
export function approveKey(id: number): string {
	return `${APPROVE}${id}`;
}

/** The ID of the held action of the approve key `key`, as text. A key that `approveKey` did not give fails. */
export function approvedId(key: string): string {
	const id = key.slice(APPROVE.length);

	if (!key.startsWith(APPROVE) || !/^[1-9]\d*$/.test(id)) throw new Error(`Not the key of an approve: ${key}`);

	return id;
}

/** The delivery that tells the agent of the approved action `held` to call it again. */
export function approveDelivery(held: HeldAction): PendingDelivery {
	return { key: approveKey(held.id), target: held.agent, text: approvedText(held), at: Date.now() };
}

/** What the send of the deliveries uses of the host. */
export type DeliveriesHost = Pick<EntryHandles, "deliver" | "warn" | "degraded"> & {
	readonly store: Pick<ProjectStore, "deliveries" | "write">;
};

/**
 * Gives each pending delivery to `deliver`, oldest first, and removes it once `deliver` took it. A delivery to a target
 * that is not a conversation or a Pi session of the host has no one to tell: it is removed with no warning. Another
 * delivery that fails stays for the next send, and is a warning and the degraded state `approve-tell` of its action,
 * which a later send that works ends. The host takes each key once, so a delivery that goes again adds nothing.
 */
export async function sendDeliveries(host: DeliveriesHost): Promise<void> {
	for (const { key, target, text } of host.store.deliveries()) {
		const id = approvedId(key);

		try {
			await host.deliver({ key, to: target, text });
		} catch (cause) {
			if (Value.Check(UnknownTarget, cause)) {
				host.store.write((tx) => tx.removeDelivery(key));
				continue;
			}

			host.warn(cause);
			host.degraded.start("approve-tell", id, `The tell of approved action ${id} failed: ${errorMessage(cause)}`);
			continue;
		}

		host.store.write((tx) => tx.removeDelivery(key));
		host.degraded.end("approve-tell", id);
	}
}
