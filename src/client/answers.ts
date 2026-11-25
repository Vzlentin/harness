/**
 * The answers of children, and the answers of the user to asks, that the host pushes to a caller that is not a
 * conversation of the host, such as a Pi session. This module has no runtime import of Pi, chord or pi-durable, so the
 * Pi extension can load it.
 */

import { type Delivery, errorMessage } from "../protocol/requests.ts";
import { type Client, connect, RETRY_DELAYS_MS, request, SHORT_CONNECTION_MS, tryEach } from "./client.ts";

export type AnswersOptions = {
	/** Whether the first try to connect starts the host when none runs. The later tries never do. */
	readonly start: boolean;
	/**
	 * The waits before the tries to connect again after a connection closed. The last one repeats until a try connects.
	 * Default 0, 2 and 5 s.
	 */
	readonly retryDelaysMs?: readonly number[];
	/** Gets the error of each reply that `onDeliveries` threw. The next replies still come. */
	readonly onError: (error: Error) => void;
};

/**
 * One open `answers` request of `caller`, on a connection of its own, that gives the deliveries of each reply to
 * `onDeliveries`, and each error that `onDeliveries` throws to `onError`. Until `close()`, it connects again after each
 * closed connection, and keeps trying while no host runs. Only the first try can start a host. `busy()` tells the host
 * whether the caller works, and each connection tells it first.
 */
export class AnswerListener {
	readonly #caller: string;
	readonly #onDeliveries: (deliveries: readonly Delivery[]) => void;
	readonly #onError: (error: Error) => void;
	readonly #retryDelaysMs: readonly number[];
	readonly #closing = new AbortController();
	#client: Client | undefined;
	/** Whether the caller works, as the last call of `busy()` says. */
	#busy = false;
	/** The `busy` requests in progress, which go one at a time, so the host gets them in order. */
	#told: Promise<void> = Promise.resolve();

	constructor(caller: string, onDeliveries: (deliveries: readonly Delivery[]) => void, options: AnswersOptions) {
		this.#caller = caller;
		this.#onDeliveries = onDeliveries;
		this.#onError = options.onError;
		this.#retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
		void this.#run(caller, options.start);
	}

	/**
	 * Tells the host whether the caller works, with a `busy` request on a connection of its own that starts no host.
	 * While the caller works, the host keeps its answers unread, for a `wait` or for the reply after it stops to work. It
	 * resolves once the host took the request, or once the request failed: the next connection of the listener then
	 * tells the host.
	 */
	busy(busy: boolean): Promise<void> {
		if (busy === this.#busy) return this.#told;
		this.#busy = busy;
		const line = { type: "busy", caller: this.#caller, busy } as const;
		const signal = this.#closing.signal;

		this.#told = this.#told.then(() =>
			request(line, { start: false, signal }).then(
				() => {},
				() => {},
			),
		);

		return this.#told;
	}

	/**
	 * Stops the listener. It drops the connection at once, so that the host does not write a reply that it would then
	 * count as given.
	 */
	close(): void {
		this.#closing.abort();
		this.#client?.abort(new Error("The answers listener is closed"));
	}

	async #run(caller: string, start: boolean): Promise<void> {
		const { signal } = this.#closing;
		// The slowest retry, which repeats while no host runs or a host closes each connection at once.
		const slow = [this.#retryDelaysMs.at(-1) ?? 0];
		let delays: readonly number[] = [0];
		let starts = start;

		while (!signal.aborted) {
			const client = await tryEach(delays, signal, async () => {
				const opened = await connect({ start: starts, signal });

				if (opened === undefined) throw new Error("No harness host runs");

				return opened;
			});

			starts = false;

			if (client instanceof Error) {
				delays = slow;
				continue;
			}

			if (signal.aborted) {
				client.close();
				break;
			}

			const opened = Date.now();
			this.#client = client;
			await this.#receive(caller, client);
			this.#client = undefined;
			client.close();
			delays = Date.now() - opened < SHORT_CONNECTION_MS ? slow : this.#retryDelaysMs;
		}
	}

	/**
	 * Tells the host on `client` whether the caller works, then gives the deliveries of each `answers` request on
	 * `client` until the connection closes.
	 */
	async #receive(caller: string, client: Client): Promise<void> {
		const told = await client.request({ type: "busy", caller, busy: this.#busy }).then(
			() => true,
			() => false,
		);

		if (!told) return;

		for (;;) {
			const deliveries = await client.request({ type: "answers", caller }).catch(() => undefined);

			if (deliveries === undefined || this.#closing.signal.aborted) return;

			try {
				this.#onDeliveries(deliveries);
			} catch (error) {
				this.#onError(error instanceof Error ? error : new Error(errorMessage(error)));
			}
		}
	}
}
