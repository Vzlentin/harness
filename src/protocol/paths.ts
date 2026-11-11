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

/** The slug of a page: lowercase words of letters and digits, joined by hyphens, as the parley skill gives it. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The state folder of harness: `$XDG_STATE_HOME/harness`, default `~/.local/state/harness`. */
function stateRoot(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harness");
}

export type StatePaths = { dir: string; socket: string; log: string };

export function statePaths(project: string): StatePaths {
	const dir = join(stateRoot(), project);

	return { dir, socket: join(dir, "host.sock"), log: join(dir, "host.log") };
}

/** The folder of the page `slug`, which the inspect routes serve. It throws for a slug that is not valid. */
export function pageDir(slug: string): string {
	if (!SLUG.test(slug)) throw new Error(`The slug must be lowercase words with hyphens: ${slug}`);

	return join(stateRoot(), "pages", slug);
}
