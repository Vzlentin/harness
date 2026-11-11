/**
 * What the Pi extension reads from a durable conversation view: its live state, its inbox, its usage, its list of todos
 * and the texts of its user messages. It imports no Pi package at run time, so the Pi extension can load it.
 */
import type { JsonRepresentation } from "@earendil-works/chord";
import type { Usage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, InboxState, JsonObject, LiveState, UsageState } from "@earendil-works/pi-durable";
import { TODO_LIST_KIND, type TodoList } from "../protocol/todo.ts";

/** The document of the kind `kind` in `view`, if the conversation has it: a built-in one, or the list of todos. */
function docOf<T extends JsonObject>(view: ConversationView, kind: string): T | undefined {
	// SAFETY: pi-durable keeps each built-in conversation document in `docs` under its kind: `pi.live` holds a
	// `LiveState`, `pi.inbox` an `InboxState` and `pi.usage` a `UsageState`. The watch of the host adds the list of
	// todos under `harness.todos`, a `TodoList` that only the host writes. Each caller passes the kind of its type.
	return view.docs[kind] as T | undefined;
}

export function liveOf(view: ConversationView): LiveState {
	return docOf<LiveState>(view, "pi.live") ?? {};
}

export function inboxOf(view: ConversationView): InboxState {
	return docOf<InboxState>(view, "pi.inbox") ?? { items: [] };
}

export function usageOf(view: ConversationView): UsageState | undefined {
	return docOf<UsageState>(view, "pi.usage");
}

/** The list of todos of the conversation; empty when it has none. */
export function todosOf(view: ConversationView): TodoList {
	return docOf<TodoList>(view, TODO_LIST_KIND) ?? { todos: [] };
}

/** The tokens and the cost of a conversation. */
export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

/** The sums of the usage of the model requests and of the tool results of the conversation, as Pi's footer counts. */
export function usageTotals(view: ConversationView): UsageTotals {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const usage = usageOf(view);

	for (const item of [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})]) {
		totals.input += item.input;
		totals.output += item.output;
		totals.cacheRead += item.cacheRead;
		totals.cacheWrite += item.cacheWrite;
		totals.cost += item.cost.total;
	}

	return totals;
}

/**
 * The usage of the last answer of the active transcript, which tells how full the context is. An aborted answer and an
 * answer that failed do not count. The active transcript starts at the `head` of the newest head marker of the window,
 * such as a compaction or a reset, or at the start of the window when that `head` is before it.
 */
export function lastAnswerUsage(view: ConversationView): Usage | undefined {
	const marker = view.entries.findLast((entry) => entry.head !== undefined);
	const head = view.entries.findIndex((entry) => entry.id === marker?.head);

	for (const entry of view.entries.slice(Math.max(0, head)).toReversed()) {
		const message = entry.model?.[0];

		if (entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;

		if (message.stopReason !== "aborted" && message.stopReason !== "error") return message.usage;
	}

	return undefined;
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

/** The texts of the queued messages that an abort withdraws, steers first, as they go back to the editor. */
export function withdrawnTexts(inbox: InboxState): string[] {
	const inputs = queued(inbox);

	return [
		...inputs.filter((input) => input.mode === "steer"),
		...inputs.filter((input) => input.mode === "followUp"),
	].map((input) => input.text);
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
			? `Retrying ${compaction.trigger} compaction (attempt ${compaction.attempt + 1})...`
			: `Compacting (${compaction.trigger})...`;
	}

	if (runningTool !== undefined) return `Running ${runningTool.name}... (esc to interrupt)`;

	if (live.run !== undefined) return "Working... (esc to interrupt)";

	return "";
}
