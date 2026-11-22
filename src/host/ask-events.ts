/**
 * The events of the answered asks, for their handlers: the handlers of the entries, in load order. The
 * commit that writes the answers adds them, so a restart of the host loses none, and the dispatcher gives them to the
 * handlers, oldest first, one at a time.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { Ask } from "../protocol/asks.ts";
import { boundedReplay } from "./checkpoint.ts";
import type { AnsweredAskEvent, AnsweredAskHandler } from "./entries.ts";
import { CommitPasses } from "./passes.ts";

const context = BACKGROUND_CONTEXT;

/**
 * The events that wait for the handler, and the number of the next key: it never goes down, so a key is never used
 * again, also when an answer replaces an earlier one.
 */
type Queue = { next: number; events: AnsweredAskEvent[] };

const AskEvents = defineDoc<Queue>({
	kind: "harness.ask-events",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ next: 1, events: [] }),
});

/** Adds one event `answer:<n>` for each answered ask of `asks` in `tx`, each with the next number. */
export async function queueAskEvents(tx: Tx, asks: readonly Ask[]): Promise<void> {
	if (asks.length === 0) return;
	const queue = await tx.doc(AskEvents);

	for (const ask of asks) {
		queue.events.push({ key: `answer:${queue.next}`, ask });
		queue.next += 1;
	}
}

/**
 * Gives each event to each of `handlers` in order, oldest first, one at a time, after each commit of the queue, and
 * removes it once every handler resolves. A handler that throws is a warning: the later handlers do not get the event,
 * and it waits for the next start of the host. `close()` aborts the handler that runs and does not wait for it: its
 * event stays for the next start, and each handler gets it again.
 */
export class AskEventDispatcher {
	readonly #harness: Harness;
	readonly #handlers: readonly AnsweredAskHandler[];
	readonly #warn: (cause: unknown) => void;
	readonly #abort = new AbortController();
	/** Resolves once `close()` aborts. */
	readonly #aborted: Promise<"aborted">;
	/** The keys of the events whose handler threw in this process. */
	readonly #failed = new Set<string>();
	readonly #passes: CommitPasses;

	constructor(harness: Harness, handlers: readonly AnsweredAskHandler[], warn: (cause: unknown) => void) {
		this.#harness = harness;
		this.#handlers = handlers;
		this.#warn = warn;
		const { signal } = this.#abort;
		this.#aborted = new Promise((resolve) =>
			signal.addEventListener("abort", () => resolve("aborted"), { once: true }),
		);

		this.#passes = new CommitPasses(
			harness,
			(change) => change.type === "document" && change.record.kind === AskEvents.definition.kind,
			() => this.#pass().catch(warn),
		);
	}

	/** Aborts the handler that runs, and stops the passes. */
	close(): Promise<void> {
		this.#abort.abort(new Error("The host is closing"));

		return this.#passes.close();
	}

	async #pass(): Promise<void> {
		const queue = await this.#harness.snapshot(AskEvents, context);
		const { signal } = this.#abort;

		for (const event of queue?.events ?? []) {
			if (signal.aborted || this.#passes.stopped) return;

			if (this.#failed.has(event.key)) continue;
			const outcome = await this.#handle(event, signal);

			if (outcome === "aborted") return;

			if (outcome === "failed") continue;

			await this.#harness.commit(async (tx) => {
				const doc = await tx.doc(AskEvents);
				doc.events = doc.events.filter(({ key }) => key !== event.key);
			}, context);
		}
	}

	/** Gives `event` to each handler in order, and stops at the first that throws, or at the close. */
	async #handle(event: AnsweredAskEvent, signal: AbortSignal): Promise<"handled" | "failed" | "aborted"> {
		for (const handler of this.#handlers) {
			try {
				const handled = Promise.resolve(handler(event, { signal }));
				// A handler that fails after the close has no one to tell.
				handled.catch(() => {});

				if ((await Promise.race([handled, this.#aborted])) === "aborted") return "aborted";
			} catch (cause) {
				this.#failed.add(event.key);
				this.#warn(cause);

				return "failed";
			}
		}

		return "handled";
	}
}
