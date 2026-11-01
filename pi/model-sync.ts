/**
 * The model and the thinking level of a mirror session. The agent in the host is the truth: the Pi session shows the
 * agent's model and level, so Pi's footer and `/model` show them, and a change that the user makes in Pi is a request
 * to the host. When the host refuses it, Pi goes back to the agent's model and level.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mirror, MirrorConfigure } from "../dist/mirror.js";
import type { ChildInfo } from "../dist/protocol.js";

/** What the sync uses of Pi's extension API. */
export type PiModels = Pick<ExtensionAPI, "setModel" | "getThinkingLevel" | "setThinkingLevel">;

/** What the sync uses of the context of the Pi session. */
export type PiSession = Pick<ExtensionContext, "model"> & {
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "find">;
};

/** What the sync uses of the mirror: the agent, and the requests that change it. */
export type MirroredAgent = Pick<Mirror, "child" | "configure">;

export class ModelSync {
	// After a session switch, `#pi` and `#ctx` are stale and throw, so nothing uses them after `close()`.
	readonly #pi: PiModels;
	readonly #ctx: PiSession;
	readonly #mirror: MirroredAgent;
	readonly #notify: (cause: unknown) => void;
	/**
	 * The model that Pi sets for the agent, while `setModel` runs: it is async, and the agent changes often while it
	 * works. Pi tells the extension the model that it takes, and that is not a choice of the user.
	 */
	#setting: { readonly provider: string; readonly model: string } | undefined;
	#closed = false;

	constructor(pi: PiModels, ctx: PiSession, mirror: MirroredAgent, notify: (cause: unknown) => void) {
		this.#pi = pi;
		this.#ctx = ctx;
		this.#mirror = mirror;
		this.#notify = notify;
	}

	/** Gives the Pi session the model and the thinking level of `child`, the agent as the host gives it. */
	fromAgent(child: ChildInfo): void {
		if (this.#closed) return;
		const model = this.#ctx.modelRegistry.find(child.provider, child.model);

		if (model !== undefined && !this.#piHasModel(child) && this.#setting === undefined) {
			const setting = { provider: child.provider, model: child.model };
			this.#setting = setting;
			// Pi sets its own thinking level when it takes a model, so the agent's level follows once Pi has the model.
			// Without a login for the model, Pi does not take it and gives `false`.
			this.#pi
				.setModel(model)
				.then((taken) => {
					if (!taken && !this.#closed)
						this.#notify(new Error(`Pi has no login for ${setting.provider}/${setting.model}`));
				})
				.catch((cause: unknown) => {
					if (!this.#closed) this.#notify(cause);
				})
				.finally(() => {
					this.#setting = undefined;
					const current = this.#mirror.child;

					if (current === undefined) return;

					// Only an agent that changed its model again while Pi set it starts another `setModel`, so a model that Pi
					// does not take does not start one again and again.
					if (current.provider !== setting.provider || current.model !== setting.model) this.fromAgent(current);
					else this.#thinkingFromAgent(current);
				});
		}

		this.#thinkingFromAgent(child);
	}

	/** Asks the host for the model that the user selected in Pi. The model that Pi takes from the agent is not asked. */
	piSelected(provider: string, model: string): void {
		const child = this.#mirror.child;
		const setting = this.#setting;

		if (setting !== undefined && setting.provider === provider && setting.model === model) return;

		if (child === undefined || (child.provider === provider && child.model === model)) return;
		this.#configure({ provider, model });
	}

	/**
	 * Asks the host for the thinking level that the user cycled to in Pi, once Pi has the agent's model. Pi also changes
	 * its level when it takes a model, so only the cycle key calls this, not each change of Pi's level.
	 */
	piCycled(): void {
		const child = this.#mirror.child;

		if (this.#closed || child === undefined || !this.#piHasModel(child)) return;
		const thinking = this.#pi.getThinkingLevel();

		if (child.thinking !== thinking) this.#configure({ thinking });
	}

	close(): void {
		this.#closed = true;
	}

	#configure(change: MirrorConfigure): void {
		this.#mirror.configure(change).catch((cause: unknown) => {
			this.#notify(cause);
			const child = this.#mirror.child;

			if (child !== undefined) this.fromAgent(child);
		});
	}

	#thinkingFromAgent(child: ChildInfo): void {
		if (!this.#closed && this.#piHasModel(child) && this.#pi.getThinkingLevel() !== child.thinking) {
			this.#pi.setThinkingLevel(child.thinking);
		}
	}

	#piHasModel(child: ChildInfo): boolean {
		const model = this.#ctx.model;

		return model?.provider === child.provider && model.id === child.model;
	}
}
