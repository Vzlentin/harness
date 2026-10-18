/**
 * What the viewer reads from the documents of a durable conversation view: its live state, its inbox and the texts of
 * its user messages.
 */
import type { JsonRepresentation } from "@earendil-works/chord";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
	type ConversationDocToken,
	type ConversationView,
	InboxDoc,
	type InboxState,
	type JsonObject,
	LiveDoc,
	type LiveState,
} from "@earendil-works/pi-durable";

/** The built-in document of `token` in `view`, if the conversation has it. */
export function docOf<T extends JsonObject>(view: ConversationView, token: ConversationDocToken<T>): T | undefined {
	// SAFETY: pi-durable keeps each built-in conversation document in `docs` under the kind of its token.
	return view.docs[token.definition.kind] as T | undefined;
}

export function liveOf(view: ConversationView): LiveState {
	return docOf(view, LiveDoc) ?? {};
}

export function inboxOf(view: ConversationView): InboxState {
	return docOf(view, InboxDoc) ?? { items: [] };
}

export function userText(content: JsonRepresentation<UserMessage["content"]>): string {
	if (!Array.isArray(content)) return content;

	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** The queued steers and follow-ups, in inbox order. */
export function queued(inbox: InboxState): { mode: "steer" | "followUp"; text: string }[] {
	return inbox.items.flatMap((item) =>
		item.mode === "write" ? [] : [{ mode: item.mode, text: userText(item.content) }],
	);
}

/** What the conversation does now, as Pi's working indicator says it; empty when it does nothing. */
export function statusText(live: LiveState): string {
	const generation = live.generation;
	const compaction = live.compactions?.[0];
	const runningTool = live.tools?.find((slot) => slot.status === "running");

	if (generation?.retry !== undefined) return `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;

	if (generation?.deferred !== undefined) return "Waiting for deferred response...";

	if (compaction !== undefined) {
		return compaction.retry
			? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...`
			: `Compacting (${compaction.reason})...`;
	}

	if (runningTool !== undefined) return `Running ${runningTool.name}... (esc to interrupt)`;

	if (live.run !== undefined) return "Working... (esc to interrupt)";

	return "";
}
