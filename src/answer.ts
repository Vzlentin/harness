/**
 * Schema answers: the `respond` tool, its `answer_schema` section and its reminders, in the `harness-answer`
 * extension. Its caller passes its pi-durable module, so a process never holds two copies.
 */
import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { type AssistantMessage, type Message, Type, validateToolArguments } from "@earendil-works/pi-ai";
import type * as Durable from "@earendil-works/pi-durable";
import type { ConversationId, Extension, HookApi, JsonObject, SubmissionId, Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { errorMessage, Json } from "./protocol.ts";

/**
 * The user message that asks again for a `respond` call after an answer of a `schema` ask without one. A reminder is
 * known by its exact text, so a user prompt with the same text counts as one.
 */
export const REMINDER = "Answer with the respond tool, as the schema in answer_schema says.";

/** The refusal of a `respond` call outside the run of a schema ask. */
const NO_STRUCTURED_ANSWER = "This turn asks for no structured answer.";

/** How many reminders one turn submission gets before its ask fails. */
const MAX_REMINDERS = 2;

/**
 * The JSON Schema of the current ask of a conversation, the request ID of the turn that sends it, its submission once
 * admitted, and the answers that `respond` checked and saved, by request ID. The schema is absent for an ask without
 * one.
 */
type AnswerState = {
	schema?: JsonObject;
	requestId?: string;
	submission?: SubmissionId;
	answers: Record<string, JsonValue>;
};

export type Answers = {
	/**
	 * The extension with `respond`; the caller installs it and selects it for each conversation that can ask with a
	 * schema.
	 */
	readonly extension: Extension;
	/**
	 * Makes `requestId` the current ask of `id`, with `schema` or without one, and offers `respond` to the model only
	 * with a schema. Keeps the saved answers and the other entries of the stored `modelTools`.
	 */
	prepare(tx: Tx, id: ConversationId, requestId: string, schema?: JsonObject): Promise<void>;
	/**
	 * Records the submission of `requestId` when it is the current ask of `id`, after its submit. `respond` and the
	 * reminders act only in the run of that submission.
	 */
	recordSubmission(tx: Tx, id: ConversationId, requestId: string): Promise<void>;
	/** The answer that `respond` saved in the turn `requestId` of `id`, if any. */
	valueIn(tx: Tx, id: ConversationId, requestId: string): Promise<JsonValue | undefined>;
};

export function createAnswers(durable: typeof Durable): Answers {
	const AnswerDoc = durable.defineDoc<AnswerState>({
		kind: "harness.answer-schema",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		checkpointWhen: () => false,
		initial: () => ({ answers: {} }),
	});

	/**
	 * Saves a schema ask's answer, checked against the schema, and ends the turn. Only a schema ask offers it, and only
	 * the run of the ask's own input can save it: a run of an earlier input refuses it.
	 */
	const respond = durable.defineTool({
		name: "respond",
		description: "Give the answer of this turn in the structured form the prompt asks for. This ends the turn.",
		parameters: Type.Object({
			answer: Type.Unknown({
				description: "The answer value itself, in the form the prompt asks for. Do not give its JSON text as a string.",
			}),
		}),
		callers: ["model"],
		deferred: true,
		execute: async (args, api, context) => {
			const result = await api.commit(async (tx): Promise<{ refused: true } | { error?: string }> => {
				const doc = await tx.doc(AnswerDoc, api.conversationId);
				const { schema, requestId } = doc;

				if (schema === undefined || requestId === undefined) return { refused: true };
				// The submission by request ID, not `doc.submission`: the run can reach this call before the ask records it.
				const submission = await tx.submissionByRequest(api.conversationId, requestId);
				const run = (await tx.doc(durable.LiveDoc, api.conversationId)).run;

				if (submission === undefined || run === undefined || !run.inputs.includes(submission.id)) {
					return { refused: true };
				}

				if (!Value.Check(Json, args.answer)) return { error: "The answer must be a JSON value." };

				try {
					doc.answers[requestId] = checkedAnswer(schema, args.answer, api.callId);
				} catch (error) {
					return { error: errorMessage(error) };
				}

				return {};
			}, context);

			if ("refused" in result) {
				return { isError: true, output: [{ type: "text", text: NO_STRUCTURED_ANSWER }] };
			}

			if (result.error !== undefined) return { isError: true, output: [{ type: "text", text: result.error }] };

			return { output: [{ type: "text", text: "Answer recorded." }], control: { terminate: true } };
		},
	});

	/**
	 * Saves the number of reminders at the end of the request as the memo `reminders` of the generation, for a schema
	 * ask only. A continuation starts a new generation, so each generation counts the reminders of its turn again from
	 * its messages. A compaction in the turn can summarize reminders away and reset the count. Each reset needs a
	 * compaction, so the turn still ends.
	 */
	const countReminders = async (
		request: { readonly messages: readonly Message[] },
		api: HookApi,
		context: Context,
	): Promise<undefined> => {
		const doc = await api.snapshot(AnswerDoc, api.conversationId, context);

		if (doc?.schema !== undefined) await api.memo("reminders", remindersAtEnd(request.messages), context);

		return undefined;
	};

	/**
	 * A reminder to call `respond`, when a schema ask got a complete answer without one and has reminders left. Only the
	 * run of the ask's own input gets it.
	 */
	const remind = async (answer: AssistantMessage, api: HookApi, context: Context) => {
		const doc = await api.snapshot(AnswerDoc, api.conversationId, context);

		if (doc?.schema === undefined || doc.requestId === undefined || doc.submission === undefined) return undefined;
		const run = (await api.snapshot(durable.LiveDoc, api.conversationId, context))?.run;

		if (run === undefined || !run.inputs.includes(doc.submission)) return undefined;

		if (Object.hasOwn(doc.answers, doc.requestId) || !complete(answer.stopReason)) return undefined;
		const count = (await api.memo<number>("reminders", context)) ?? 0;

		return count < MAX_REMINDERS ? { continue: REMINDER } : undefined;
	};

	const extension = durable.defineExtension({
		name: "harness-answer",
		tools: [respond],
		hooks: [durable.hook(durable.GenerationTask, { beforeRequest: countReminders, onYield: remind })],
		sections: [
			durable.section("answer_schema", async ({ read, conversationId }, context) => {
				const schema = (await read.snapshot(AnswerDoc, conversationId, context))?.schema;

				return schema && `The answer of respond must match this JSON Schema:\n${JSON.stringify(schema)}`;
			}),
		],
	});

	return {
		extension,
		async prepare(tx, id, requestId, schema) {
			const doc = await tx.doc(AnswerDoc, id);

			if (schema === undefined) delete doc.schema;
			else doc.schema = schema;
			doc.requestId = requestId;
			delete doc.submission;
			const agent = await tx.doc(durable.AgentDoc, id);
			const name = respond.name;
			const tools = agent.modelTools;

			if (schema !== undefined) {
				if (!Array.isArray(tools)) {
					const remove = tools?.remove?.filter((tool) => tool !== name);
					const add = (tools?.add ?? []).filter((tool) => tool !== name);
					agent.modelTools = remove === undefined ? { add: [...add, name] } : { remove, add: [...add, name] };
				} else if (!tools.includes(name)) tools.push(name);
			} else if (Array.isArray(tools)) {
				if (tools.includes(name)) agent.modelTools = tools.filter((tool) => tool !== name);
			} else if (tools?.add?.includes(name)) {
				agent.modelTools = { ...tools, add: tools.add.filter((tool) => tool !== name) };
			}
		},
		async recordSubmission(tx, id, requestId) {
			const doc = await tx.doc(AnswerDoc, id);
			const submission = doc.requestId === requestId ? await tx.submissionByRequest(id, requestId) : undefined;

			if (submission !== undefined) doc.submission = submission.id;
		},
		async valueIn(tx, id, requestId) {
			const { answers } = await tx.doc(AnswerDoc, id);

			// A copy, because the draft is not readable after the commit.
			return Object.hasOwn(answers, requestId) ? copyJson(answers[requestId]) : undefined;
		},
	};
}

/** True when an answer with `stopReason` reached its end; any other answer is cut. */
export function complete(stopReason: string): boolean {
	return stopReason === "stop" || stopReason === "toolUse";
}

/** The number of reminders at the end of `messages`, counting back to the first other user message. */
function remindersAtEnd(messages: readonly Message[]): number {
	let count = 0;

	for (const message of messages.toReversed()) {
		if (message.role !== "user") continue;
		const { content } = message;

		const text = Array.isArray(content)
			? content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
			: content;

		if (text !== REMINDER) break;
		count++;
	}

	return count;
}

/**
 * `answer` checked against `schema`, as `validateToolArguments` returns it. A string answer that does not match is
 * parsed as JSON, and an object or array is checked again, because a model can send it as its JSON text. Any other
 * string throws the first error.
 */
function checkedAnswer(schema: JsonObject, answer: JsonValue, id: string): JsonValue {
	const parameters = Type.Object({ answer: Type.Unsafe<JsonValue>(schema) });

	const check = (value: JsonValue): JsonValue =>
		validateToolArguments(
			{ name: "respond", description: "", parameters },
			{ type: "toolCall", id, name: "respond", arguments: { answer: value } },
		).answer;

	try {
		return check(answer);
	} catch (error) {
		if (!Value.Check(Type.String(), answer)) throw error;
		let parsed: JsonValue;

		try {
			parsed = JSON.parse(answer);
		} catch {
			throw error;
		}

		if (!(parsed instanceof Object)) throw error;

		return check(parsed);
	}
}
