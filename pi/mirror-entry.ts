/**
 * The mirror entry of a session, which makes it a mirror session (see `mirror.ts`).
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MirrorTarget } from "../dist/client/mirror.js";
import type { Harness } from "./index.ts";

/** The mirror entry of a session: its ID and its target. */
export type MirrorEntry = { readonly id: string; readonly target: MirrorTarget };

/** The newest mirror entry of `entries` with a valid target. */
export function mirrorEntry(
	harness: Pick<Harness, "mirror">,
	entries: readonly SessionEntry[],
): MirrorEntry | undefined {
	const { MIRROR_ENTRY, fromMirrorEntry, isMirrorEntry } = harness.mirror;

	for (const entry of entries.toReversed()) {
		if (entry.type === "custom" && entry.customType === MIRROR_ENTRY && isMirrorEntry(entry.data)) {
			return { id: entry.id, target: fromMirrorEntry(entry.data) };
		}
	}

	return undefined;
}
