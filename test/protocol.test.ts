import { describe, expect, it } from "vitest";
import { isValidRunName } from "../src/protocol.ts";

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
