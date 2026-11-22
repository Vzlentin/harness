/**
 * The held actions of the agents that ended: the end of a child drops its held actions, and the open of the entry drops
 * those of each child that ended while the host was down.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { EntryHandles } from "../host/entries.ts";
import { dropHeldOf, readHeld } from "./project.ts";

const context = BACKGROUND_CONTEXT;

/** What the drops of the held actions of the ended agents use of the host. */
export type EndedAgentsHost = Pick<EntryHandles, "endedChild" | "warn"> & {
	readonly harness: Pick<Harness, "snapshot" | "commit">;
};

/** Drops each held action of the agent `agent` that ended, for the caller `agent`. A repeat changes nothing. */
export async function dropHeldOfEnded(host: Pick<EndedAgentsHost, "harness">, agent: string): Promise<void> {
	await host.harness.commit((tx) => dropHeldOf(tx, agent), context);
}

/**
 * Drops the held actions of each agent that is a child of the host that ended. The entry runs it once at its open. A
 * failure is a warning.
 */
export async function dropHeldOfEndedAgents(host: EndedAgentsHost): Promise<void> {
	try {
		const { held } = await readHeld(host.harness, context);
		const agents = new Set(held.filter((action) => action.state === "held").map((action) => action.agent));

		for (const agent of agents) {
			if (await host.endedChild(agent)) await dropHeldOfEnded(host, agent);
		}
	} catch (cause) {
		host.warn(cause);
	}
}
