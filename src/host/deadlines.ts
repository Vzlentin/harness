/**
 * The deadline of the turns of the RLM children: the host aborts a turn that runs for longer.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type CommitObservation,
	type ConversationId,
	type Harness,
	LiveDoc,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { Passes } from "./passes.ts";
import { ChildRecords, isRlmChild, recordsByAge } from "./records.ts";

const context = BACKGROUND_CONTEXT;

/** What the deadlines use of the host. */
export type DeadlinesHost = {
	readonly harness: Harness;
	readonly warn: (cause: unknown) => void;
	/** The time of a turn. */
	readonly deadlineMs: number;
};

/**
 * The timer of the turn of a conversation. A turn is one run, named by its first input, or undefined for a run that
 * already answered when the timer started.
 */
type Deadline = { readonly turn: SubmissionId | undefined; readonly timer: ReturnType<typeof setTimeout> };

/**
 * Aborts each turn of an RLM child that runs for longer than `deadlineMs`, as the `abort` request does: the child stays
 * open. A check of a conversation runs after each commit that changes its live state, and for every RLM child at the
 * start, so a busy RLM child gets a full deadline when the host starts. A run whose inputs are settled, which runs only
 * its after-run tasks, keeps the timer of its turn.
 */
export class Deadlines {
	readonly #host: DeadlinesHost;
	readonly #deadlines = new Map<ConversationId, Deadline>();
	/** The conversations to check at the next check. */
	readonly #marked = new Set<ConversationId>();
	readonly #observation: CommitObservation;
	readonly #passes = new Passes(() => this.#pass());
	#closed = false;

	/** Writes `cause` as a warning, unless the deadlines are closed, as the store may then be. */
	readonly #warn = (cause: unknown): void => {
		if (!this.#closed) this.#host.warn(cause);
	};

	constructor(host: DeadlinesHost) {
		this.#host = host;
		// The listener only schedules a check: it must not call the store.
		this.#observation = host.harness.observeCommits({
			advance: (publication) => {
				for (const change of publication.changes) {
					if (change.type !== "document" || change.record.kind !== LiveDoc.definition.kind) continue;

					if (change.conversationId !== undefined) this.#mark(change.conversationId);
				}
			},
			end: () => {},
		});
		void this.#markAll().catch(this.#warn);
	}

	/** Stops the checks and the timers. */
	close(): void {
		this.#closed = true;
		this.#passes.stop();
		this.#observation.detach();

		for (const { timer } of this.#deadlines.values()) clearTimeout(timer);
		this.#deadlines.clear();
		this.#marked.clear();
	}

	/** Marks every RLM child for a check. */
	async #markAll(): Promise<void> {
		const state = await this.#host.harness.snapshot(ChildRecords, context);

		for (const [, record] of recordsByAge(state)) {
			if (record.kind === "rlm") this.#mark(record.conversationId);
		}
	}

	/** Marks `id` for a check, and schedules one. Calls while checks run give one more round. */
	#mark(id: ConversationId): void {
		if (this.#closed) return;
		this.#marked.add(id);
		this.#passes.request();
	}

	/** Checks the conversations that are marked, and clears the marks. */
	async #pass(): Promise<void> {
		const marked = [...this.#marked];
		this.#marked.clear();
		await this.#checkAll(marked).catch(this.#warn);
	}

	/** Checks each of `marked`, one at a time. */
	async #checkAll(marked: readonly ConversationId[]): Promise<void> {
		const state = await this.#host.harness.snapshot(ChildRecords, context);

		for (const id of marked) {
			if (isRlmChild(state, id)) await this.#check(id);
			else this.#clear(id);
		}
	}

	/** Starts the timer of a new turn of the RLM child `id`, or clears its timer when it runs no turn. */
	async #check(id: ConversationId): Promise<void> {
		const run = (await this.#host.harness.snapshot(LiveDoc, id, context))?.run;

		if (this.#closed) return;

		if (run === undefined) {
			this.#clear(id);

			return;
		}

		const turn = run.inputs[0];
		const current = this.#deadlines.get(id);

		if (current !== undefined && (turn === undefined || turn === current.turn)) return;
		this.#clear(id);
		const timer = setTimeout(() => void this.#expire(id, turn).catch(this.#warn), this.#host.deadlineMs);
		// The timer alone does not keep the host running.
		timer.unref();
		this.#deadlines.set(id, { turn, timer });
	}

	/** Aborts the run of `id` when it is still the turn `turn`. */
	async #expire(id: ConversationId, turn: SubmissionId | undefined): Promise<void> {
		this.#deadlines.delete(id);
		const run = (await this.#host.harness.snapshot(LiveDoc, id, context))?.run;

		if (this.#closed || run === undefined) return;

		// A new first input is a new turn, which its own check times.
		if (run.inputs[0] !== undefined && run.inputs[0] !== turn) {
			this.#mark(id);

			return;
		}

		const conversation = await this.#host.harness.conversation(id, context);
		await conversation?.abort(context);
	}

	#clear(id: ConversationId): void {
		clearTimeout(this.#deadlines.get(id)?.timer);
		this.#deadlines.delete(id);
	}
}
