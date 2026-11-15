/**
 * The degraded states of a host: each one has a kind, a cause, a line for the user and the time of its start. A source
 * starts a state when its cause starts, and ends it when its cause ends.
 */
import type { DegradedKind, DegradedState } from "../protocol/project.ts";
import { errorMessage } from "../protocol/requests.ts";

type Listener = () => void;

/** The degraded states of a host, by kind and cause, and the listeners of their changes. */
export class Degraded {
	/** The states, by the key of their kind and cause, each with its cause. */
	readonly #states = new Map<string, { readonly cause: string; readonly state: DegradedState }>();
	readonly #listeners = new Set<Listener>();
	readonly #warn: (cause: unknown) => void;
	readonly #now: () => number;

	/** `warn` writes the warning of a state that `warn` or `guard` starts, as `warning: <line>` in the host. */
	constructor(warn: (cause: unknown) => void, now: () => number = Date.now) {
		this.#warn = warn;
		this.#now = now;
	}

	/**
	 * Starts the state `kind` of `cause` with `line`. A state that continues keeps the time of its start and takes the
	 * new line. The listeners run only when the list changes.
	 */
	start(kind: DegradedKind, cause: string, line: string): void {
		const key = stateKey(kind, cause);
		const known = this.#states.get(key);

		if (known?.state.line === line) return;
		this.#states.set(key, { cause, state: { kind, line, since: known?.state.since ?? this.#now() } });
		this.#changed();
	}

	/** Writes the warning `line`, then starts the state `kind` of `cause` with it. */
	warn(kind: DegradedKind, cause: string, line: string): void {
		this.#warn(new Error(line));
		this.start(kind, cause, line);
	}

	/**
	 * Runs `run`. When it works, ends the state `kind` of `cause` and gives its result. When it fails, writes the warning
	 * `<prefix><error>`, starts the state with that line, and gives undefined. It never throws.
	 */
	async guard<T>(kind: DegradedKind, cause: string, prefix: string, run: () => Promise<T>): Promise<T | undefined> {
		try {
			const result = await run();
			this.end(kind, cause);

			return result;
		} catch (error) {
			this.warn(kind, cause, `${prefix}${errorMessage(error)}`);

			return undefined;
		}
	}

	/** Ends the state `kind` of `cause`. It does nothing when the state is not there. */
	end(kind: DegradedKind, cause: string): void {
		if (this.#states.delete(stateKey(kind, cause))) this.#changed();
	}

	/** Ends each state `kind` whose cause is not in `causes`. */
	keepOnly(kind: DegradedKind, causes: ReadonlySet<string>): void {
		const ended = [...this.#states].filter(([, { cause, state }]) => state.kind === kind && !causes.has(cause));

		for (const [key] of ended) this.#states.delete(key);

		if (ended.length > 0) this.#changed();
	}

	/** The states, oldest first, then by kind. */
	list(): DegradedState[] {
		return [...this.#states.values()]
			.map(({ state }) => state)
			.sort((a, b) => a.since - b.since || a.kind.localeCompare(b.kind));
	}

	/** Calls `listener` after each change of the list, and gives the function that stops it. */
	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);

		return () => {
			this.#listeners.delete(listener);
		};
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}
}

function stateKey(kind: DegradedKind, cause: string): string {
	return JSON.stringify([kind, cause]);
}
