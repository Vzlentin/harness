/**
 * The checkpoint rule of the documents that live as long as their store or their conversation. pi-durable stores a
 * document as bases, each the whole value, and deltas, each the changes of one commit, and a load applies every delta
 * after the newest base. A commit that the rule of a document accepts stores a base, and the storage then drops the
 * revisions before it. A document with the rule `() => false` keeps one delta for each commit that ever changed it.
 */
import type { Op } from "@earendil-works/chord/delta";
import type { CheckpointInfo, JsonObject } from "@earendil-works/pi-durable";

/** How many deltas a document can have after its base. */
export const MAX_DELTAS = 64;

/**
 * The rule of a document whose value can grow, the rule of pi-durable for a keyed map: the commit after `MAX_DELTAS`
 * deltas stores a base. The document has at most `MAX_DELTAS + 1` revisions, and a commit does not store the whole
 * value each time. A document whose value stays small has the rule `() => true`: it is one revision.
 */
export function afterMaxDeltas(
	_value: Readonly<JsonObject>,
	_ops: readonly Op[],
	{ deltasSinceBase }: CheckpointInfo,
): boolean {
	return deltasSinceBase >= MAX_DELTAS;
}
