/**
 * The answers of the user that wait to go to their askers. The commit that writes the answers of asks adds them here,
 * so a restart of the host loses none. The push removes each one after its delivery, and a caller can remove the answers
 * of some asks, as the take of a parley does: its taker gets the answers in its reply.
 */
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type DocumentReader, type Harness, type Tx } from "@earendil-works/pi-durable";
import { boundedReplay } from "../protocol/checkpoint.ts";
import type { UserDelivery } from "../protocol/requests.ts";

/** One answer that waits for its asker, with its delivery, written in the commit of the answers. */
export type UserAnswer = { id: number; asker: string; delivery: UserDelivery };

/** A user answer before it has an ID. */
export type UserAnswerInput = Omit<UserAnswer, "id">;

/** The queue, and the ID of the next answer: it never goes down, so the ID of a delivery is never used again. */
type Queue = { next: number; deliveries: UserAnswer[] };

const UserAnswers = defineDoc<Queue>({
	kind: "harness.user-answers",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ next: 1, deliveries: [] }),
});

/** The kind of the document of the queue. */
export const USER_ANSWERS_KIND = UserAnswers.definition.kind;

/** Adds `answers` to the queue in `tx`, each with the next ID. */
export async function queueAnswers(tx: Tx, answers: readonly UserAnswerInput[]): Promise<void> {
	if (answers.length === 0) return;
	const queue = await tx.doc(UserAnswers);

	for (const answer of answers) {
		queue.deliveries.push({ id: queue.next, asker: answer.asker, delivery: answer.delivery });
		queue.next += 1;
	}
}

/** Removes each answer whose delivery gives one of the asks `asks` from the queue in `tx`, for every asker. */
export async function dropAnswers(tx: Tx, asks: readonly number[]): Promise<void> {
	const queue = await tx.doc(UserAnswers);
	queue.deliveries = queue.deliveries.filter(({ delivery }) => {
		const given = delivery.source === "ask" ? [delivery.ask] : delivery.asks;

		return !given.some((id) => asks.includes(id));
	});
}

/** The answers that wait, oldest first. */
export async function readUserAnswers(
	reader: Pick<DocumentReader, "snapshot">,
	context: Context,
): Promise<UserAnswer[]> {
	const queue = await reader.snapshot(UserAnswers, context);

	return queue?.deliveries ?? [];
}

/** Removes the answer `id` from the queue, after its delivery. */
export async function removeUserAnswer(harness: Harness, id: number, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const queue = await tx.doc(UserAnswers);
		queue.deliveries = queue.deliveries.filter((answer) => answer.id !== id);
	}, context);
}
