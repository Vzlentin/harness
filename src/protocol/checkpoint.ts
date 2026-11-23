/**
 * The checkpoint rule of the documents of the harness store, those of the host and those of the children. A rule that
 * never checkpoints lets the replay tail of a document grow without bound, and a rule that always checkpoints writes
 * the whole document on each change.
 */
import type { Op } from "@earendil-works/chord/delta";
import type { CheckpointInfo, JsonObject } from "@earendil-works/pi-durable";

/** The most deltas that a read of a document replays after its newest base. */
const MAX_REPLAY = 64;

/** Stores a change as a complete base when the document already has `MAX_REPLAY` deltas after its newest base. */
export function boundedReplay(_value: Readonly<JsonObject>, _ops: readonly Op[], info: CheckpointInfo): boolean {
	return info.deltasSinceBase >= MAX_REPLAY;
}
