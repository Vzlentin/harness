/**
 * The pool of the model requests of the RLM children: each tree runs at most a fixed number of them at the same time.
 */

/** A request that waits for a slot of its tree. `order` is its age: a smaller one came first. */
type Waiter = { readonly depth: number; readonly order: number; readonly grant: () => void };

/** The requests of one tree: its key, how many hold a slot, and those that wait. */
type Tree = { readonly key: string; running: number; readonly waiters: Waiter[] };

/**
 * Slots for the model requests of each tree, `size` for each one. When a slot frees, the waiting request with the
 * smallest depth gets it, then the oldest.
 */
export class RequestPool {
	readonly #size: number;
	readonly #trees = new Map<string, Tree>();
	#order = 0;

	constructor(size: number) {
		this.#size = size;
	}

	/**
	 * Waits for a slot of `tree` for a request at `depth`, and gives the function that frees it. An abort of `signal`
	 * removes the waiting request, which then rejects with the reason of the signal, or frees the slot that the request
	 * holds. A second call of the release function does nothing.
	 */
	acquire(tree: string, depth: number, signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(signal.reason);
		const state = this.#trees.get(tree) ?? { key: tree, running: 0, waiters: [] };
		this.#trees.set(tree, state);

		if (state.running < this.#size) {
			state.running += 1;

			return Promise.resolve(this.#held(state, signal));
		}

		return new Promise((resolve, reject) => {
			const leave = () => {
				state.waiters.splice(state.waiters.indexOf(waiter), 1);
				this.#forget(state);
				reject(signal.reason);
			};

			const waiter: Waiter = {
				depth,
				order: this.#order++,
				grant: () => {
					signal.removeEventListener("abort", leave);
					resolve(this.#held(state, signal));
				},
			};

			signal.addEventListener("abort", leave, { once: true });
			state.waiters.push(waiter);
		});
	}

	/** The release function of a slot of the tree `state` that a request holds, which an abort of `signal` calls too. */
	#held(state: Tree, signal: AbortSignal): () => void {
		let held = true;

		const release = () => {
			if (!held) return;
			held = false;
			signal.removeEventListener("abort", release);
			this.#free(state);
		};

		signal.addEventListener("abort", release, { once: true });

		return release;
	}

	/** Gives the freed slot of the tree `state` to the waiting request with the smallest depth, then the oldest. */
	#free(state: Tree): void {
		state.running -= 1;
		let next: Waiter | undefined;

		for (const waiter of state.waiters) {
			if (next === undefined || waiter.depth < next.depth || (waiter.depth === next.depth && waiter.order < next.order))
				next = waiter;
		}

		if (next === undefined) {
			this.#forget(state);

			return;
		}

		state.waiters.splice(state.waiters.indexOf(next), 1);
		state.running += 1;
		next.grant();
	}

	/** Forgets the tree `state` once no request holds or waits for a slot of it. */
	#forget(state: Tree): void {
		if (state.running === 0 && state.waiters.length === 0) this.#trees.delete(state.key);
	}
}
