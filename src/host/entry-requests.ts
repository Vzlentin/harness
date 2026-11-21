/**
 * The requests of the types that the entries serve: a handler that gives the reply, or a watch that gives the state as
 * the reply and then sends the events of the entry.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type { EntryLine, EntryRequest } from "./entries.ts";
import type { Connection } from "./push.ts";
import { serveConnectionWatch } from "./store-watch.ts";

/**
 * The reply of the entry's `served` type to `request`. A watch needs `connection`, and fails without it with
 * `A <type> watch needs a connection`.
 */
export function serveEntryRequest(
	served: EntryRequest,
	request: EntryLine,
	signal: AbortSignal,
	connection: Connection | undefined,
): Promise<JsonValue> {
	if (served.handle !== undefined) return served.handle(request, { signal });

	if (connection === undefined) throw new Error(`A ${served.type} watch needs a connection`);

	return serveEntryWatch(served, request, signal, connection);
}

/** Opens the watch of `served` for `request` on `connection`, and returns its state as the reply. */
function serveEntryWatch(
	served: Extract<EntryRequest, { watch: unknown }>,
	request: EntryLine,
	signal: AbortSignal,
	connection: Connection,
): Promise<JsonValue> {
	return serveConnectionWatch(connection, signal, (options) => served.watch(request, options));
}
