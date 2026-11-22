import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, type EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { HARNESS_HOST, MEMORY_DIR, PI_MODEL, PI_PROVIDER, PI_REASONING_LEVEL, PI_SESSION_ID } from "../protocol/env.ts";
import { memoryDir } from "../protocol/hosts.ts";

/**
 * The envs of the conversations of the host `host`, whose directory is `hostCwd`. A conversation keeps its env
 * while its cwd and shell values stay the same; a configure gives it a new env. An env is cleaned up only at close,
 * because a cleanup kills the commands that run in it. A replaced env with no command that runs is dropped instead.
 */
export class ConversationEnvs {
	readonly #host: string;
	readonly #hostCwd: string;
	/** The current env of each conversation, with the values that made it. */
	readonly #current = new Map<ConversationId, { readonly key: string; readonly env: CountingEnv }>();
	/** The envs that this made and that are current or run a command. */
	#made: CountingEnv[] = [];

	constructor(host: string, hostCwd: string) {
		this.#host = host;
		this.#hostCwd = hostCwd;
	}

	/** The env of the conversation of `target`, for the `env` option of `Harness.open`. */
	async env({ conversationId, cwd, read }: EnvTarget, envContext: Context): Promise<NodeExecutionEnv | undefined> {
		if (cwd === undefined) return undefined;
		const agent = await read.snapshot(AgentDoc, conversationId, envContext);

		// An undefined MEMORY_DIR removes the host's own value from the shell.
		const shellEnv: NodeJS.ProcessEnv = {
			[PI_SESSION_ID]: String(conversationId),
			[HARNESS_HOST]: this.#host,
			[MEMORY_DIR]: memoryDir(this.#host, this.#hostCwd),
		};

		if (agent?.model !== undefined) {
			shellEnv[PI_PROVIDER] = agent.model.provider;
			shellEnv[PI_MODEL] = agent.model.modelId;
		}

		if (agent?.thinkingLevel !== undefined) shellEnv[PI_REASONING_LEVEL] = agent.thinkingLevel;
		const key = JSON.stringify({ cwd, shellEnv });
		const known = this.#current.get(conversationId);

		if (known?.key === key) return known.env;
		const env = new CountingEnv({ cwd, shellEnv });
		this.#current.set(conversationId, { key, env });
		const current = new Set([...this.#current.values()].map((entry) => entry.env));
		this.#made = [...this.#made.filter((made) => current.has(made) || made.running > 0), env];

		return env;
	}

	async cleanup(cleanupContext: Context): Promise<void> {
		for (const env of this.#made) await env.cleanup(cleanupContext);
	}
}

/** A `NodeExecutionEnv` that counts the commands that run in it. */
class CountingEnv extends NodeExecutionEnv {
	running = 0;

	override async exec(...args: Parameters<NodeExecutionEnv["exec"]>): ReturnType<NodeExecutionEnv["exec"]> {
		this.running += 1;

		try {
			return await super.exec(...args);
		} finally {
			this.running -= 1;
		}
	}
}
