/**
 * The deliveries of the entries: texts that wait to go to hosted conversations as input, or to Pi sessions in the reply
 * of their `answers` request, once for each key. The push sends each one, then removes it from the queue.
 */
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { boundedReplay } from "./checkpoint.ts";
import { EntryDelivery } from "./entries.ts";
import { knownSession } from "./sessions.ts";
import { library } from "./targets.ts";

/** The key of a delivery and its destination. */
type Sent = { key: string; to: string };

/**
 * The deliveries that wait, oldest first, and the deliveries that went to a Pi session. A hosted conversation keeps the
 * request ID of each input that it took, and a Pi session does not, so `sent` keeps its keys.
 */
const Deliveries = defineDoc<{ deliveries: EntryDelivery[]; sent: Sent[] }>({
	kind: "harness.deliveries",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ deliveries: [], sent: [] }),
});

/** The kind of the document of the queue. */
export const DELIVERIES_KIND = Deliveries.definition.kind;

/** The request ID of the input of the delivery `key`. The conversation takes a request ID once. */
export function deliveryRequest(key: string): string {
	return `delivery:${key}`;
}

/**
 * Queues `delivery` for the push, in the store of `harness` whose root conversation is `root`. Its `to` must be the
 * root, a conversation that the children library opened, or a Pi session of the host. It does nothing when the key
 * waits for `to`, or when `to` took it. It throws for an invalid delivery, and for another `to`.
 */
export async function queueDelivery(
	harness: Pick<Harness, "commit">,
	root: ConversationId,
	delivery: EntryDelivery,
	context: Context,
): Promise<void> {
	if (!Value.Check(EntryDelivery, delivery)) throw new Error("Invalid delivery: it needs a key, a to and a text");
	const { key, to, text } = delivery;

	await harness.commit(async (tx) => {
		const id = to === String(root) ? root : await library.opened(tx, to);

		if (id === undefined && !(await knownSession(tx, to)))
			throw new Error(`${to} is not a conversation or a Pi session of the host`);
		const queue = await tx.doc(Deliveries);
		const same = (each: Sent) => each.key === key && each.to === to;

		if (queue.deliveries.some(same) || queue.sent.some(same)) return;

		if (id !== undefined && (await tx.submissionByRequest(id, deliveryRequest(key))) !== undefined) return;
		queue.deliveries.push({ key, to, text });
	}, context);
}

/** The deliveries that wait, oldest first. */
export async function readDeliveries(harness: Pick<Harness, "snapshot">, context: Context): Promise<EntryDelivery[]> {
	return (await harness.snapshot(Deliveries, context))?.deliveries ?? [];
}

/**
 * Removes the delivery `key` of `to` from the queue in `tx`, after its input, or after the reply to the `answers`
 * request of the Pi session `to`, which `replied` says and which then keeps the key in `sent`.
 */
export async function removeDelivery(tx: Tx, key: string, to: string, replied: boolean): Promise<void> {
	const queue = await tx.doc(Deliveries);
	queue.deliveries = queue.deliveries.filter((each) => each.key !== key || each.to !== to);

	if (replied) queue.sent = [...queue.sent, { key, to }];
}
