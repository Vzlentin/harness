import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, type EnvTarget } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { memoryDir } from "./projects.ts";

/**
 * The envs of the conversations of the host of `project`, whose directory is `projectCwd`. A conversation keeps its env
 * while its cwd and shell values stay the same; a configure gives it a new env. Every env is cleaned up only at close,
 * because a cleanup kills the commands that run in it.
 */
export class ConversationEnvs {
	readonly #project: string;
	readonly #projectCwd: string;
	/** The current env of each conversation, with the values that made it. */
	readonly #current = new Map<ConversationId, { readonly key: string; readonly env: NodeExecutionEnv }>();
	/** Every env that this made. */
	readonly #made: NodeExecutionEnv[] = [];

	constructor(project: string, projectCwd: string) {
		this.#project = project;
		this.#projectCwd = projectCwd;
	}

	/** The env of the conversation of `target`, for the `env` option of `Harness.open`. */
	async env({ conversationId, cwd, read }: EnvTarget, envContext: Context): Promise<NodeExecutionEnv | undefined> {
		if (cwd === undefined) return undefined;
		const agent = await read.snapshot(AgentDoc, conversationId, envContext);

		// An undefined MEMORY_DIR removes the host's own value from the shell.
		const shellEnv: NodeJS.ProcessEnv = {
			PI_SESSION_ID: String(conversationId),
			HARNESS_PROJECT: this.#project,
			MEMORY_DIR: memoryDir(this.#project, this.#projectCwd),
		};

		if (agent?.model !== undefined) {
			shellEnv.PI_PROVIDER = agent.model.provider;
			shellEnv.PI_MODEL = agent.model.modelId;
		}

		if (agent?.thinkingLevel !== undefined) shellEnv.PI_REASONING_LEVEL = agent.thinkingLevel;
		const key = JSON.stringify({ cwd, shellEnv });
		const current = this.#current.get(conversationId);

		if (current?.key === key) return current.env;
		const env = new NodeExecutionEnv({ cwd, shellEnv });
		this.#current.set(conversationId, { key, env });
		this.#made.push(env);

		return env;
	}

	async cleanup(cleanupContext: Context): Promise<void> {
		for (const env of this.#made) await env.cleanup(cleanupContext);
	}
}
