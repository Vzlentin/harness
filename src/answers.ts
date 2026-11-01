/**
 * The answers that the host pushes to a caller that is not a conversation of the host, such as a Pi session. This
 * module has no runtime import of Pi, chord or pi-durable, so the Pi extension can load it.
 */
import { type Client, connect, RETRY_DELAYS_MS, SHORT_CONNECTION_MS, tryEach } from "./client.ts";
import { type Delivery, errorMessage } from "./protocol.ts";

export type AnswersOptions = {
	/** Whether the first try to connect starts the host when none runs. The later tries never do. */
	readonly start: boolean;
	/**
	 * The waits before the tries to connect again after a connection closed. The last one repeats until a try connects.
	 * Default 0, 2 and 5 s.
	 */
	readonly retryDelaysMs?: readonly number[];
	/** Gets the error of each delivery that `onDelivery` threw. The next deliveries still come. */
	readonly onError: (error: Error) => void;
};

/**
 * One open `answers` request of `caller`, on a connection of its own, that gives each answer to `onDelivery`, and each
 * error that `onDelivery` throws to `onError`. Until `close()`, it connects again after each closed connection, and
 * keeps trying while no host runs. Only the first try can start a host.
 */
export class AnswerListener {
	readonly #onDelivery: (delivery: Delivery) => void;
	readonly #onError: (error: Error) => void;
	readonly #retryDelaysMs: readonly number[];
	readonly #closing = new AbortController();
	#client: Client | undefined;

	constructor(caller: string, onDelivery: (delivery: Delivery) => void, options: AnswersOptions) {
		this.#onDelivery = onDelivery;
		this.#onError = options.onError;
		this.#retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
		void this.#run(caller, options.start);
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

	/** Gives the answers of each `answers` request on `client` until the connection closes. */
	async #receive(caller: string, client: Client): Promise<void> {
		for (;;) {
			const deliveries = await client.request({ type: "answers", caller }).catch(() => undefined);

			if (deliveries === undefined || this.#closing.signal.aborted) return;

			for (const delivery of deliveries) {
				try {
					this.#onDelivery(delivery);
				} catch (error) {
					this.#onError(error instanceof Error ? error : new Error(errorMessage(error)));
				}
			}
		}
	}
}
