/**
 * The held actions of the agents that ended: the end of a child drops its held actions, and the open of the entry drops
 * those of each child that ended while the host was down.
 */
import type { EntryHandles } from "../host/entries.ts";
import type { ProjectStore } from "./project-store.ts";
import { dropHeldOf } from "./project.ts";

/** What the drops of the held actions of the ended agents use of the host. */
export type EndedAgentsHost = Pick<EntryHandles, "endedChild" | "warn"> & {
	readonly store: ProjectStore;
};

/** Drops each held action of the agent `agent` that ended, for the caller `agent`. A repeat changes nothing. */
export async function dropHeldOfEnded(host: Pick<EndedAgentsHost, "store">, agent: string): Promise<void> {
	host.store.write((tx) => dropHeldOf(tx, agent));
}

/**
 * Drops the held actions of each agent that is a child of the host that ended. The entry runs it once at its open. A
 * failure is a warning.
 */
export async function dropHeldOfEndedAgents(host: EndedAgentsHost): Promise<void> {
	try {
		const held = host.store.held().filter((action) => action.state === "held");
		const agents = new Set(held.map((action) => action.agent));

		for (const agent of agents) {
			if (await host.endedChild(agent)) await dropHeldOfEnded(host, agent);
		}
	} catch (cause) {
		host.warn(cause);
	}
}
