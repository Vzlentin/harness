/**
 * A mirror session is a Pi session that shows a conversation of a harness host and sends what the user types to it.
 * The conversation stays in the host; the Pi session keeps only its target, in one custom entry. This module has no
 * runtime import of Pi, chord or pi-durable, so the Pi extension can load it.
 */
import { randomUUID } from "node:crypto";
import type { ConversationView } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type Client, connect } from "./client.ts";
import { applyChange, type ChildInfo, type Request, type WatchLine } from "./protocol.ts";
import { inboxOf, withdrawnTexts } from "./view-state.ts";

/** The `customType` of the session entry that holds the target of a mirror session. */
export const MIRROR_ENTRY = "harness-mirror";

/** The conversation that a mirror session shows: the child or project agent `handle` of the host of `project`. */
export const MirrorTarget = Type.Object({ project: Type.String(), handle: Type.String() });

export type MirrorTarget = Static<typeof MirrorTarget>;

/** Whether the data of a session entry is a mirror target. */
export function isMirrorTarget(data: unknown): data is MirrorTarget {
	return Value.Check(MirrorTarget, data);
}

/** A change of the model or the thinking level of the mirrored conversation. */
export type MirrorConfigure = Omit<Extract<Request, { type: "configure" }>, "type" | "handle">;

/** Why a watch ended: the child was stopped, or the connection closed, after `close()` or because the host closed it. */
export type MirrorEnd = "stopped" | "closed";

/**
 * A live copy of one conversation of a harness host, from the host's watch, and the requests that act on it. The
 * connection is open until `close()` or until the host ends the watch.
 */
export class Mirror {
	view: ConversationView;
	child: ChildInfo;
	/** Resolves when the watch ends. */
	readonly ended: Promise<MirrorEnd>;
	readonly #client: Client;
	readonly #handle: string;
	readonly #onChange: () => void;
	readonly #end: (end: MirrorEnd) => void;

	private constructor(
		client: Client,
		handle: string,
		watched: Awaited<ReturnType<Client["watch"]>>,
		onChange: () => void,
	) {
		this.#client = client;
		this.#handle = handle;
		this.#onChange = onChange;
		this.view = watched.view;
		this.child = watched.child;
		const { promise, resolve } = Promise.withResolvers<MirrorEnd>();
		this.ended = promise;
		this.#end = resolve;
		void this.#follow(watched.lines);
	}

	/**
	 * Connects to the host of `target.project`, which starts when none runs, and watches the conversation of `target`.
	 * `onChange` runs after each change of `view` or `child`. It rejects when the host refuses the watch, such as for an
	 * unknown child or a project agent without a model, and when `signal` aborts the wait for a host that starts.
	 */
	static async open(target: MirrorTarget, onChange: () => void, signal?: AbortSignal): Promise<Mirror> {
		const client = await connect({ start: true, project: target.project, signal });

		if (client === undefined) throw new Error("Could not connect to the harness host");

		try {
			return new Mirror(client, target.handle, await client.watch(target.handle), onChange);
		} catch (error) {
			client.close();
			throw error;
		}
	}

	get busy(): boolean {
		return this.child.state === "busy";
	}

	/** Sends `message`: a new turn when the conversation is idle, else a steer, or a follow-up with `followUp`. */
	async send(message: string, followUp: boolean): Promise<void> {
		const request = { type: "input", requestId: randomUUID(), handle: this.#handle, message, followUp } as const;
		this.child = (await this.#client.request(request)).child;
	}

	/** Aborts the turn, and gives the texts of the queued messages that the host withdraws, steers first. */
	async abort(): Promise<string[]> {
		const texts = withdrawnTexts(inboxOf(this.view));
		this.child = await this.#client.request({ type: "abort", handle: this.#handle });

		return texts;
	}

	/** Changes the model or the thinking level. The host refuses a model it does not know and a level it does not have. */
	async configure(change: MirrorConfigure): Promise<void> {
		this.child = await this.#client.request({ type: "configure", handle: this.#handle, ...change });
	}

	/** Closes the connection. The conversation keeps running in the host. */
	close(): void {
		this.#client.close();
	}

	async #follow(lines: AsyncIterable<WatchLine>): Promise<void> {
		for await (const line of lines) {
			if (line.stopped) {
				this.#end("stopped");

				return;
			}

			this.view = applyChange(this.view, line.change);
			this.child = line.child;
			this.#onChange();
		}

		this.#end("closed");
	}
}
