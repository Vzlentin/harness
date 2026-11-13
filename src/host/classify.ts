/**
 * The classifier models of Pi's settings, and the questions of `classify-todos` to one of them: whether an open todo
 * needs the user's call, and whether it repeats an earlier todo of its list.
 */
import type {
	ClassifierApi,
	ClassifierAnswer,
	ClassifierContext,
	ClassifierModel,
	ClassifierQuestion,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Todo, TodoAnswer } from "../protocol/todo.ts";

/** The classifier of each setting when Pi's settings do not have it. */
const DEFAULT_CLASSIFIERS = {
	todoClassifier: "typesafe/jev-latest",
	gateClassifier: "openrouter/typesafe/jev-1.14",
} as const;

/** A setting of Pi that names a classifier model. */
export type ClassifierKey = keyof typeof DEFAULT_CLASSIFIERS;

/** The classifier settings of Pi's settings, of any type. */
const ClassifierSettings = Type.Object({
	todoClassifier: Type.Optional(Type.Unknown()),
	gateClassifier: Type.Optional(Type.Unknown()),
});

/** A probability of `needsYou` from which the answer is yes. */
const NEEDS_YOU_FROM = 0.5;

const NEEDS_YOU: ClassifierQuestion = {
	type: "bool",
	instructions: "Does the todo in `todo` need a call that only the user can make?",
	criteria: {
		true: "The todo waits for a decision, an approval, a preference or an answer that only the user can give.",
		false: "An agent can do the todo without the user.",
	},
};

/**
 * The classifier model of the setting `key` in Pi's effective settings, `<provider>/<id>`, read again at each call, or
 * its default without it: `typesafe/jev-latest` for `todoClassifier`, and `openrouter/typesafe/jev-1.14` for
 * `gateClassifier`. It fails when the model is unknown or its provider has no credential.
 */
export async function classifierModel(
	settings: SettingsManager,
	models: Models,
	key: ClassifierKey,
): Promise<ClassifierModel<ClassifierApi>> {
	await settings.reload();
	const effective = settings.getSettings();
	const set = Value.Check(ClassifierSettings, effective) ? effective[key] : undefined;
	const value = set === undefined ? DEFAULT_CLASSIFIERS[key] : set;
	// A value that is not a string names no model: it fails as its JSON text.
	const name = Value.Check(Type.String(), value) ? value : JSON.stringify(value);
	const slash = name.indexOf("/");
	const provider = slash === -1 ? name : name.slice(0, slash);
	const id = slash === -1 ? "" : name.slice(slash + 1);
	const available = await models.getAvailableOfType("classifier", provider);
	const model = available.find((found) => found.provider === provider && found.id === id);

	if (model === undefined) throw new Error(`No classifier: log in to ${provider} or set ${key}`);

	return model;
}

/** The answers of `model` in `context`. A call that does not end with the stop reason `stop` fails. */
export async function askClassifier(
	models: Models,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	signal: AbortSignal,
): Promise<ClassifierResult["answers"]> {
	const result = await models.classify(model, context, { signal });

	if (result.stopReason !== "stop") {
		throw new Error(`${classifierFailed(model)}: ${result.errorMessage ?? result.stopReason}`);
	}

	return result.answers;
}

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

/**
 * The answers of `model` about the open todos of `todos` whose ID is in `ids`, default every open todo, in ID order. An
 * ID that is not in `todos` fails with `Unknown todo: <id>`. Each todo gets one call, with the todos before it.
 */
export async function classifyTodos(
	models: Models,
	model: ClassifierModel<ClassifierApi>,
	todos: readonly Todo[],
	ids: readonly number[] | undefined,
	signal: AbortSignal,
): Promise<TodoAnswer[]> {
	const unknown = ids?.find((id) => !todos.some((todo) => todo.id === id));

	if (unknown !== undefined) throw new Error(`Unknown todo: ${unknown}`);

	const asked = todos.filter((todo) => todo.state === "open" && (ids === undefined || ids.includes(todo.id)));

	return Promise.all(asked.map((todo) => classifyTodo(models, model, todo, todos, signal)));
}

/** The answer of `model` about `todo`, with the todos of `todos` that have a lower ID as the earlier ones. */
async function classifyTodo(
	models: Models,
	model: ClassifierModel<ClassifierApi>,
	todo: Todo,
	todos: readonly Todo[],
	signal: AbortSignal,
): Promise<TodoAnswer> {
	const earlier = todos.filter((found) => found.id < todo.id);
	const state = { todo: { id: todo.id, text: todo.text }, earlier };

	const questions =
		earlier.length === 0 ? { needsYou: NEEDS_YOU } : { needsYou: NEEDS_YOU, repeats: repeatsQuestion(earlier) };

	const answers = await askClassifier(models, model, { state, questions }, signal);
	const needsYou = answerOf(model, answers, "needsYou", "bool");
	const answer: TodoAnswer = { id: todo.id, needsYou: needsYou.probability >= NEEDS_YOU_FROM };
	const repeats = answers.repeats;

	const repeated =
		repeats?.type === "choice" ? earlier.find((found) => String(found.id) === repeats.choice) : undefined;

	return repeated === undefined ? answer : { ...answer, repeats: repeated.id };
}

/** The question whether a todo repeats one of `earlier`, with one choice for each of them and the choice `none`. */
function repeatsQuestion(earlier: readonly Todo[]): ClassifierQuestion {
	const criteria = Object.fromEntries(
		earlier.map((todo) => [String(todo.id), `It repeats todo ${todo.id}: ${todo.text}`]),
	);

	return {
		type: "choice",
		instructions: "Does the todo in `todo` ask for the same work as one of the todos in `earlier`?",
		criteria: { none: "It repeats no todo in `earlier`.", ...criteria },
	};
}
