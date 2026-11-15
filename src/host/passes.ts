/**
 * The passes that the host runs after commits, such as the sweeps of the push.
 */
import { setImmediate } from "node:timers/promises";
import type { CommitChange, CommitObservation, Harness } from "@earendil-works/pi-durable";

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
	/** The loop of passes in progress, which `close()` awaits. */
	#loop: Promise<void> = Promise.resolve();

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
		this.#loop = this.#run();
	}

	/** Stops the passes: no pass starts after it. */
	stop(): void {
		this.#stopped = true;
	}

	/** Stops the passes, and waits for the pass in progress. */
	async close(): Promise<void> {
		this.stop();
		await this.#loop;
	}

	async #run(): Promise<void> {
		await setImmediate();

		while (this.#dirty && !this.#stopped) {
			this.#dirty = false;
			await this.#pass();
		}

		this.#running = false;
	}
}

/**
 * The passes that each commit with a change that `filter` accepts requests. The first pass runs at once, and `close()`
 * stops the passes, detaches the listener and waits for the pass in progress.
 */
export class CommitPasses extends Passes {
	readonly #observation: CommitObservation;

	constructor(
		harness: Pick<Harness, "observeCommits">,
		filter: (change: CommitChange) => boolean,
		pass: () => Promise<void>,
	) {
		super(pass);
		// The listener only requests a pass: it must not call the store.
		this.#observation = harness.observeCommits({
			advance: (publication) => {
				if (publication.changes.some(filter)) this.request();
			},
			end: () => {},
		});
		this.request();
	}

	override async close(): Promise<void> {
		this.#observation.detach();
		await super.close();
	}
}
