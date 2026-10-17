/**
 * What the viewer reads from the documents of a durable conversation view: its live state, its inbox and the texts of
 * its user messages.
 */
import type { UserMessage } from "@earendil-works/pi-ai";
import { type ConversationView, InboxDoc, type InboxState, LiveDoc, type LiveState } from "@earendil-works/pi-durable";

export function liveOf(view: ConversationView): LiveState {
	return (view.docs[LiveDoc.definition.kind] as LiveState | undefined) ?? {};
}

export function inboxOf(view: ConversationView): InboxState {
	return (view.docs[InboxDoc.definition.kind] as InboxState | undefined) ?? { items: [] };
}

export function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** The queued steers and follow-ups, in inbox order. */
export function queued(inbox: InboxState): { mode: "steer" | "followUp"; text: string }[] {
	return inbox.items.flatMap((item) =>
		item.mode === "write" ? [] : [{ mode: item.mode, text: userText(item.content as UserMessage["content"]) }],
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
