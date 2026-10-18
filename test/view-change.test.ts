import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { applyChange, viewChange } from "../src/view-change.ts";

const before: ConversationView = JSON.parse(
	JSON.stringify({
		conversation: { id: "c1" },
		entries: [
			{ id: "e1", conversationId: "c1", kind: "pi.user", data: { text: "one" } },
			{ id: "e2", conversationId: "c1", kind: "pi.assistant", data: { text: "two" } },
			{ id: "e3", conversationId: "c1", kind: "pi.assistant", data: { text: "three" } },
		],
		docs: { "pi.live": { generation: 1 }, "pi.inbox": { items: [] } },
	}),
);

/** The view after `ops`, as chord applies them, and as a client rebuilds it from the change that the host sends. */
function both(ops: readonly Op[]) {
	const after = applyImmutable(before, ops);

	return { after, rebuilt: applyChange(before, viewChange(after, ops)) };
}

describe("view change", () => {
	it.each<[string, readonly Op[]]>([
		["a new entry", [["p", ["entries"], 3, 0, [{ id: "e4", conversationId: "c1", kind: "pi.user" }]]]],
		["a change in an entry", [["s", ["entries", 1, "data", "text"], "changed"]]],
		["a text that grows in an entry", [["a", ["entries", 2, "data", "text"], " more"]]],
		["a removed entry", [["p", ["entries"], 0, 1, []]]],
		["reordered entries", [["m", ["entries"], [2, 0, 1]]]],
		["a new entries array", [["s", ["entries"], []]]],
		["a changed document", [["s", ["docs", "pi.live", "generation"], 2]]],
		["a removed document", [["d", ["docs", "pi.inbox"]]]],
		["a new document", [["s", ["docs", "pi.usage"], { models: {} }]]],
		["a changed conversation", [["s", ["conversation", "owner"], { conversationId: "c0", taskId: "t1" }]]],
		["a replaced view", [["r", { conversation: { id: "c2" }, entries: [], docs: {} }]]],
		["a part that the change does not know", [["s", ["other"], 1]]],
		[
			"ops on several parts",
			[
				["s", ["entries", 2, "data", "text"], "late"],
				["s", ["entries", 0, "data", "text"], "early"],
				["d", ["docs", "pi.live"]],
				["s", ["conversation", "id"], "c3"],
			],
		],
	])("rebuilds the view after %s", (_name, ops) => {
		const { after, rebuilt } = both(ops);

		expect(rebuilt).toEqual(after);
	});

	it("sends only the entries from the first one that an op reached", () => {
		const after = applyImmutable(before, [["s", ["entries", 2, "data", "text"], "changed"]]);

		expect(viewChange(after, [["s", ["entries", 2, "data", "text"], "changed"]])).toEqual({
			entries: { from: 2, items: [after.entries[2]] },
		});
	});
});
