/**
 * The Pi sessions of the host: the callers that opened an `answers` request. A session ends when it has no open
 * `answers` socket for `SESSION_END_MS`, and its end ends its children. The document of the sessions keeps them over a
 * restart of the host, so a session whose listener does not come back after a restart ends too.
 */
import type { Socket } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { boundedReplay } from "./checkpoint.ts";
import { ChildRecords } from "./records.ts";
import { endChildren, type TargetHost } from "./targets.ts";

const context = BACKGROUND_CONTEXT;

/** How long a session may have no open `answers` socket before it ends. */
export const SESSION_END_MS = 30_000;

/** The callers that opened an `answers` request and whose end did not run yet. */
const SessionsDoc = defineDoc<{ callers: string[] }>({
	kind: "subagent.sessions",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ callers: [] }),
});

/** Whether `caller` is a Pi session of the host, as the document of the sessions says in `tx`. */
export async function knownSession(tx: Tx, caller: string): Promise<boolean> {
	return (await tx.doc(SessionsDoc)).callers.includes(caller);
}

type SessionsHost = Pick<TargetHost, "harness" | "place" | "owner"> & {
	readonly warn: (cause: unknown) => void;
};

/**
 * The sessions of the host and the timers of their ends. The end of a session closes its children and their subtrees,
 * and marks read the records of the subtrees only, so the session gets the answers of its own children when it comes
 * back.
 */
export class Sessions {
	readonly #host: SessionsHost;
	readonly #endMs: number;
	/** The callers of the document. */
	readonly #callers: Set<string>;
	/** The open `answers` sockets of each caller. */
	readonly #sockets = new Map<string, Set<Socket>>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** The ends in progress, which `close()` awaits. */
	readonly #ending = new Set<Promise<void>>();
	#closed = false;

	private constructor(host: SessionsHost, endMs: number, callers: readonly string[]) {
		this.#host = host;
		this.#endMs = endMs;
		this.#callers = new Set(callers);

		// The delay of a saved session counts from the start of the host.
		for (const caller of callers) this.#startTimer(caller);
	}

	/** The sessions of the store of `host`, each with a timer that ends it after `endMs`, unless its listener is back. */
	static async open(host: SessionsHost, endMs: number): Promise<Sessions> {
		const saved = await host.harness.snapshot(SessionsDoc, context);

		return new Sessions(host, endMs, saved?.callers ?? []);
	}

	/** Counts `socket` as an open `answers` socket of `caller`, until it closes. */
	async listen(caller: string, socket: Socket): Promise<void> {
		if (this.#closed) return;
		const sockets = this.#sockets.get(caller) ?? new Set<Socket>();
		this.#sockets.set(caller, sockets);

		if (!sockets.has(socket)) {
			sockets.add(socket);
			socket.once("close", () => this.#socketClosed(caller, socket));
		}

		clearTimeout(this.#timers.get(caller));
		this.#timers.delete(caller);

		if (this.#callers.has(caller)) return;
		this.#callers.add(caller);
		await this.#host.harness.commit(async (tx) => {
			const doc = await tx.doc(SessionsDoc);

			if (!doc.callers.includes(caller)) doc.callers.push(caller);
		}, context);
	}

	/** Stops the timers, ignores the later socket closes, and waits for the ends in progress. */
	async close(): Promise<void> {
		this.#closed = true;

		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
		await Promise.allSettled(this.#ending);
	}

	#socketClosed(caller: string, socket: Socket): void {
		const sockets = this.#sockets.get(caller);
		sockets?.delete(socket);

		if (this.#closed || (sockets?.size ?? 0) > 0) return;
		this.#sockets.delete(caller);
		this.#startTimer(caller);
	}

	#startTimer(caller: string): void {
		clearTimeout(this.#timers.get(caller));
		const timer = setTimeout(() => this.#fire(caller), this.#endMs);
		// The timer alone does not keep the host running.
		timer.unref();
		this.#timers.set(caller, timer);
	}

	#fire(caller: string): void {
		this.#timers.delete(caller);

		if (this.#closed || this.#sockets.has(caller)) return;

		const ending: Promise<void> = this.#end(caller)
			.catch(this.#host.warn)
			.finally(() => this.#ending.delete(ending));

		this.#ending.add(ending);
	}

	/**
	 * Ends the children of `caller`, then removes it from the document, unless its listener came back during the end:
	 * an end that started finishes.
	 */
	async #end(caller: string): Promise<void> {
		const { harness } = this.#host;
		const state = await harness.snapshot(ChildRecords, context);
		const records = Object.values(state?.children ?? {}).filter((record) => record.caller === caller);

		await endChildren(this.#host, records, { keepAnswers: true });

		if (this.#sockets.has(caller)) return;
		this.#callers.delete(caller);
		await removeCaller(harness, caller);
	}
}

async function removeCaller(harness: Harness, caller: string): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = await tx.doc(SessionsDoc);
		doc.callers = doc.callers.filter((saved) => saved !== caller);
	}, context);
}
