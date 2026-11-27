import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI of this install, which the detached starts of the host and the hc terminals of `openChildTab` and
 * `openConversationPane` run with this Node: `cli.js` next to the built modules, or `cli.ts` in a checkout, which Node
 * runs with type stripping.
 */
export function cliPath(): string {
	return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../cli.ts" : "../cli.js", import.meta.url));
}

/** The slug of a parley: lowercase words of letters and digits, joined by hyphens, as the parley skill gives it. */
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The state folder of harness: `$XDG_STATE_HOME/harness`, default `~/.local/state/harness`. */
function stateRoot(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harness");
}

export type StatePaths = { dir: string; socket: string; log: string; store: string };

export function statePaths(host: string): StatePaths {
	const dir = join(stateRoot(), host);

	return { dir, socket: join(dir, "host.sock"), log: join(dir, "host.log"), store: join(dir, "store.json") };
}
