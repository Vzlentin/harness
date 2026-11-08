import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI of this install, which the host start and the hc terminals of `openChildTab` and `openConversationPane` run
 * with this Node: `cli.js` next to the built modules, or `cli.ts` in a checkout, which Node runs with type stripping.
 */
export function cliPath(): string {
	return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../cli.ts" : "../cli.js", import.meta.url));
}

export type StatePaths = { dir: string; socket: string; log: string };

export function statePaths(project: string): StatePaths {
	const dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harness", project);

	return { dir, socket: join(dir, "host.sock"), log: join(dir, "host.log") };
}
