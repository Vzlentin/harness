/**
 * An entry that serves `fixture.shout`, and `fixture.relay`, which sends a request of the type `to` with its text
 * through the `send` of the scope of the host, and replies with the reply or with the error.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { EntryHandles, EntryLine } from "../../src/host/entries.ts";
import { errorMessage } from "../../src/protocol/requests.ts";

const Shout = Type.Object({ type: Type.Literal("fixture.shout"), text: Type.String({ minLength: 1 }) });

const Relay = Type.Object({ type: Type.Literal("fixture.relay"), to: Type.String(), text: Type.String() });

export default function scopeRelayEntry({ scope }: Pick<EntryHandles, "scope">) {
	const shout = {
		type: "fixture.shout",
		schema: Shout,
		passive: () => true,
		handle: async (request: EntryLine) => ({ shout: Value.Parse(Shout, request).text.toUpperCase() }),
	};

	const relay = {
		type: "fixture.relay",
		schema: Relay,
		passive: () => true,
		handle: async (request: EntryLine, { signal }: { readonly signal: AbortSignal }) => {
			const { to, text } = Value.Parse(Relay, request);

			try {
				return await scope.send({ type: to, text }, signal);
			} catch (error) {
				return { error: errorMessage(error) };
			}
		},
	};

	return { extensions: [], requests: [shout, relay], close: async () => {} };
}
