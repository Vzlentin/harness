/**
 * The `query` request: a model of Pi's settings answers one question about a conversation of the host, from its
 * messages and tool calls. It writes nothing and starts no turn.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Conversation, ConversationId, Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseModelSetting, subagentModel } from "../children/model.ts";
import { CLI_CALLER } from "../protocol/env.ts";
import { userText } from "../protocol/gate.ts";
import { MAX_QUERY, QUERY_CUT_LINE } from "../protocol/query.ts";
import type { Replies, Request } from "../protocol/requests.ts";
import type { Target } from "../protocol/target.ts";
import { callerEntry, type TargetHost, targetConversation } from "./targets.ts";

const context = BACKGROUND_CONTEXT;

/** The number of entries that one page of the read of a conversation gives. */
const PAGE = 50;

const QuerySetting = Type.Object({ queryModel: Type.String() });

const SYSTEM_PROMPT = `You answer one question about the conversation of an agent, from its transcript.
The transcript has the messages of the user, the text of the assistant, and each tool call with its arguments. It has no thinking and no tool output.
Answer from the transcript only. When it does not have the answer, say so.`;

/** What a query uses of the host. */
export type QueryHost = Pick<TargetHost, "harness" | "place"> & {
	readonly root: Conversation;
	/** Pi's settings, for `queryModel` and the default model. */
	readonly settings: SettingsManager;
	readonly signal: AbortSignal;
};

/** The answer of the query model to the question of `request` about the conversation of `ref`. */
export async function queryConversation(
	request: Extract<Request, { type: "query" }>,
	ref: Target,
	host: QueryHost,
): Promise<Replies["query"]> {
	const id = await queriedConversation(host, ref, request.caller);
	const model = await queryModel(host.settings, host.place.models);
	const { text, cut } = await transcript(host, id);
	const prompt = `<transcript>\n${text}\n</transcript>\n\nQuestion: ${request.question}`;
	const message: Message = { role: "user", content: prompt, timestamp: Date.now() };

	const reply = await host.place.models.completeSimple(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
		{ signal: host.signal },
	);

	if (reply.stopReason !== "stop") {
		throw new Error(`The query model ${model.provider}/${model.id} failed: ${reply.errorMessage ?? reply.stopReason}`);
	}

	const answer = answerText(reply);

	return { answer: cut ? `${QUERY_CUT_LINE}\n${answer}` : answer };
}

/**
 * The conversation of `ref`, when `caller` may query it. `cli`, a terminal that is not an agent, may query any target.
 * Another caller may query only a child that it spawned, by handle or by conversation ID.
 */
async function queriedConversation(host: QueryHost, ref: Target, caller: string): Promise<ConversationId> {
	if (caller === CLI_CALLER) return targetConversation(host, ref);

	if (ref.kind === "agent") throw new Error("Only a terminal that is not an agent can query the project agent");

	return (await callerEntry(host, ref, caller))[1].conversationId;
}

/**
 * The query model: `queryModel` of Pi's effective settings, read again at each query, else `subagentModel`, else Pi's
 * default model. An unknown model, and a provider with no credential, fail.
 */
async function queryModel(settings: SettingsManager, models: Models): Promise<Model<Api>> {
	await settings.reload();
	const effective = settings.getSettings();
	const set = Value.Check(QuerySetting, effective) ? parseModelSetting(effective.queryModel) : undefined;
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();

	const chosen =
		set ??
		subagentModel(settings) ??
		(provider === undefined || modelId === undefined ? undefined : { provider, model: modelId });

	if (chosen === undefined) {
		throw new Error("No model for a query: set queryModel, subagentModel or a default model in Pi");
	}

	const model = models.getModel(chosen.provider, chosen.model);

	if (model === undefined) throw new Error(`Unknown model: ${chosen.provider}/${chosen.model}`);

	if (!(await models.getAvailable(chosen.provider)).some((found) => found.id === model.id)) {
		throw new Error(`No credential for ${chosen.provider}: log in to ${chosen.provider} or set queryModel`);
	}

	return model;
}

/**
 * The transcript of the conversation `id`, oldest first, and whether it is cut: the last `MAX_QUERY` of it in UTF-8, on
 * a character boundary. The entries are read newest first, and the read stops once it has more than the bound.
 */
async function transcript(host: QueryHost, id: ConversationId): Promise<{ text: string; cut: boolean }> {
	const conversation = await host.harness.conversation(id, context);

	if (conversation === undefined) throw new Error(`Missing conversation ${id}`);
	const parts: string[] = [];
	let size = 0;
	let cursor: Cursor | undefined;

	do {
		const page = await conversation.entries({}, PAGE, cursor, context);

		for (const entry of page.items) {
			const text = entryText(entry);

			if (text === "") continue;
			parts.push(text);
			size += Buffer.byteLength(text, "utf8") + 2;

			if (size > MAX_QUERY.bytes) return { text: lastPart(parts.reverse().join("\n\n")), cut: true };
		}

		cursor = page.next;
	} while (cursor !== undefined);

	return { text: parts.reverse().join("\n\n"), cut: false };
}

/** The last `MAX_QUERY` of `text` in UTF-8, from a character boundary. */
function lastPart(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	let start = Math.max(0, bytes.length - MAX_QUERY.bytes);

	// A UTF-8 continuation byte is `10xxxxxx`: the character starts after it.
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;

	return bytes.subarray(start).toString("utf8");
}

/** The text of the model messages of `entry`: the user messages, and the text and tool calls of the assistant. */
function entryText(entry: EntryRecord): string {
	return (entry.model ?? []).flatMap(messageLines).join("\n\n");
}

function messageLines(message: Message): string[] {
	switch (message.role) {
		case "user": {
			const text = userText(message.content);

			return text === "" ? [] : [`User: ${text}`];
		}

		case "assistant":
			return message.content.flatMap((part) => {
				if (part.type === "text") return part.text === "" ? [] : [`Assistant: ${part.text}`];

				if (part.type === "toolCall") return [`Tool call ${part.name}: ${JSON.stringify(part.arguments)}`];

				return [];
			});

		default:
			return [];
	}
}

/** The text parts of `reply`, joined. */
function answerText(reply: AssistantMessage): string {
	return reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
