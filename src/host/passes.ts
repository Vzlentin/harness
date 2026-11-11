/**
 * The passes that the host runs after commits, such as the sweeps of the push.
 */

/**
 * Runs `pass` after each request, one pass at a time, out of the commit listener, which must not call the store. The
 * requests during a pass give one more pass after it. `pass` must not reject: it handles its own errors.
 */
export class Passes {
	readonly #pass: () => Promise<void>;
	/** Whether a request came after the start of the last pass. */
	#dirty = false;
	#running = false;
	#stopped = false;

	constructor(pass: () => Promise<void>) {
		this.#pass = pass;
	}

	/** Whether the passes stopped. A pass that runs can read it after each wait, to stop early. */
	get stopped(): boolean {
		return this.#stopped;
	}

	/** Requests a pass. After `stop()`, it does nothing. */
	request(): void {
		if (this.#stopped) return;
		this.#dirty = true;

		if (this.#running) return;
		this.#running = true;
		setImmediate(() => void this.#run());
	}

	/** Stops the passes: no pass starts after it. */
	stop(): void {
		this.#stopped = true;
	}

	async #run(): Promise<void> {
		while (this.#dirty && !this.#stopped) {
			this.#dirty = false;
			await this.#pass();
		}

		this.#running = false;
	}
}
