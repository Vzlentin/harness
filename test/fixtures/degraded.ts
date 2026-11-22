/**
 * An entry that serves `fixture.degraded`: the degraded states of the host, which the tests read in place of a watch
 * of an entry.
 */
import { Type } from "typebox";
import type { Degraded } from "../../src/host/degraded.ts";

export default function degradedEntry({ degraded }: { readonly degraded: Degraded }) {
	const request = {
		type: "fixture.degraded",
		schema: Type.Object({ type: Type.Literal("fixture.degraded") }),
		passive: () => true,
		handle: async () => ({ degraded: degraded.list() }),
	};

	return { extensions: [], requests: [request], close: async () => {} };
}
