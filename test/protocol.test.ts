import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { isValidRunName } from "../src/protocol/labels.ts";
import { PROTOCOL_VERSION, RequestLine, THINKING_LEVELS } from "../src/protocol/requests.ts";

describe("THINKING_LEVELS", () => {
	it("has pi-ai's thinking levels, in pi-ai's order", () => {
		expect(THINKING_LEVELS).toEqual(MODEL_THINKING_LEVELS);
	});
});

describe("isValidRunName", () => {
	it("refuses U+0000 to U+001F and U+007F in a name", () => {
		for (const code of [...Array.from({ length: 0x20 }, (_, index) => index), 0x7f]) {
			expect(isValidRunName(`a${String.fromCharCode(code)}b`)).toBe(false);
		}
	});

	it("takes other characters, also U+0080 to U+009F", () => {
		for (const code of [0x20, 0x7e, 0x80, 0x85, 0x9f, 0xa0, 0x2028, 0xd800, 0xfffd]) {
			expect(isValidRunName(`a${String.fromCharCode(code)}b`)).toBe(true);
		}

		expect(isValidRunName("reviewer 😀")).toBe(true);
	});

	it("refuses an empty name, a name over 64 characters and a name with outer spaces", () => {
		expect(isValidRunName("")).toBe(false);
		expect(isValidRunName("a".repeat(64))).toBe(true);
		expect(isValidRunName("a".repeat(65))).toBe(false);
		expect(isValidRunName(" a")).toBe(false);
		expect(isValidRunName("a ")).toBe(false);
	});
});

describe("the memory request", () => {
	it("takes one line for each action of the memory tool, and the snapshot, in protocol 36", () => {
		expect(PROTOCOL_VERSION).toBe(36);

		for (const line of [
			{ type: "memory", action: "note", text: "The user drinks tea." },
			{ type: "memory", action: "recall", pattern: "tea" },
			{ type: "memory", action: "zoom", block: "0-1" },
			{ type: "memory", action: "snapshot" },
		]) {
			expect(Value.Check(RequestLine, line)).toBe(true);
		}
	});

	it("refuses an action without its field, and an unknown action", () => {
		for (const line of [
			{ type: "memory", action: "note" },
			{ type: "memory", action: "recall" },
			{ type: "memory", action: "zoom" },
			{ type: "memory", action: "forget", text: "tea" },
		]) {
			expect(Value.Check(RequestLine, line)).toBe(false);
		}
	});
});
