import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ConversationId, ConversationView, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { lastAnswerUsage, usageTotals } from "../src/client/view-state.ts";

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

// SAFETY: an ID is a number, and the functions under test do not look it up.
const conversationId = 1 as ConversationId;

function answer(id: number, stopReason: AssistantMessage["stopReason"], answerUsage: Usage): EntryRecord {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "p",
		model: "m",
		usage: answerUsage,
		stopReason,
		timestamp: 0,
	};

	// SAFETY: as for `conversationId`.
	return { id: id as EntryId, conversationId, kind: "pi.assistant", model: [message] };
}

/** A head marker, such as a compaction or a reset, whose active transcript starts at `head`. */
function marker(id: number, head: number): EntryRecord {
	// SAFETY: as for `conversationId`.
	return { id: id as EntryId, conversationId, kind: "marker", head: head as EntryId };
}

function view(entries: EntryRecord[]): ConversationView {
	return { conversation: { id: conversationId }, entries, docs: {} };
}

describe("view state", () => {
	it("sums the usage of the requests and the tool results, and takes the context from the last full answer", () => {
		const first = usage(100, 20, 300, 10, 0.5);

		const view: ConversationView = {
			conversation: { id: conversationId },
			entries: [answer(1, "stop", first), answer(2, "aborted", usage(7, 0, 0, 0, 0))],
			docs: { "pi.usage": { models: { "p/m": first }, tools: { bash: usage(5, 0, 0, 0, 0.01) } } },
		};

		const totals = usageTotals(view);
		expect(totals).toMatchObject({ input: 105, output: 20, cacheRead: 300, cacheWrite: 10 });
		expect(totals.cost).toBeCloseTo(0.51);
		expect(lastAnswerUsage(view)).toEqual(first);
	});

	it("takes the context only from the answers after the head of the newest head marker", () => {
		const before = answer(1, "stop", usage(100, 20, 300, 10, 0.5));
		const keptUsage = usage(50, 5, 0, 0, 0.1);
		const kept = answer(2, "stop", keptUsage);

		expect(lastAnswerUsage(view([before, marker(2, 2)]))).toBeUndefined();
		expect(lastAnswerUsage(view([before, kept, marker(3, 2)]))).toEqual(keptUsage);
		expect(lastAnswerUsage(view([before, marker(3, 1), kept, marker(4, 4)]))).toBeUndefined();
	});
});
