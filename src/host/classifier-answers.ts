/**
 * The answers of a classifier model to one call: the answer to one question of a known type, and the start of the
 * error of a call that failed.
 */
import type { ClassifierAnswer, ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";

/**
 * The answer of `model` in `answers` to the question `key`, of the type `type`. A missing answer, or one of another type,
 * fails with `<failed>: no answer to <key>`.
 */
export function answerOf<T extends "bool" | "choice">(
	model: ClassifierModel<ClassifierApi>,
	answers: ClassifierResult["answers"],
	key: string,
	type: T,
): Extract<ClassifierAnswer, { type: T }> {
	const answer = answers[key];

	if (!hasType(answer, type)) throw new Error(`${classifierFailed(model)}: no answer to ${key}`);

	return answer;
}

function hasType<T extends ClassifierAnswer["type"]>(
	answer: ClassifierAnswer | undefined,
	type: T,
): answer is Extract<ClassifierAnswer, { type: T }> {
	return answer?.type === type;
}

/** The start of the error of a call of `model` that failed. */
export function classifierFailed(model: ClassifierModel<ClassifierApi>): string {
	return `The classifier ${model.provider}/${model.id} failed`;
}
