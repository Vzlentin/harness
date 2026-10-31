/**
 * The overlay of a child: file contents that the child sees in place of the disk. Its caller passes the pi-durable
 * module, as for the children library, so this module imports pi-durable as types only.
 */
import { isAbsolute, resolve } from "node:path";
import type * as Durable from "@earendil-works/pi-durable";

/** File contents by path: a string replaces the file, null removes it. */
export type Overlay = { readonly [path: string]: string | null };

type OverlayState = { files: Overlay };

/** The overlay of a conversation, by absolute path. A conversation opened without one has no doc: readers get undefined. */
export function overlayDoc(durable: Pick<typeof Durable, "defineDoc">) {
	return durable.defineDoc<OverlayState>({
		kind: "harness.overlay",
		version: 1,
		scope: "conversation",
		history: "latest",
		checkpointWhen: () => false,
		fork: "current",
		initial: () => ({ files: {} }),
	});
}

/** `overlay` with each key resolved against `cwd`, lexically. A relative key without `cwd` throws. */
export function resolveOverlay(overlay: Overlay, cwd: string | undefined): Overlay {
	return Object.fromEntries(Object.entries(overlay).map(([key, content]) => [resolveKey(key, cwd), content]));
}

function resolveKey(key: string, cwd: string | undefined): string {
	if (isAbsolute(key)) return resolve(key);

	if (cwd !== undefined) return resolve(cwd, key);
	throw new Error(`The overlay key ${key} is relative, and the child has no working directory`);
}
