/**
 * The requests of the types that the entries serve: a handler that gives the reply, or a watch that gives the state as
 * the reply and then sends the events of the entry.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type { EntryLine, EntryRequest } from "./entries.ts";
import type { Connection } from "./push.ts";

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

/**
 * Opens the watch of `served` for `request` on `connection`, and returns its state as the reply. Each `emit` of the watch
 * becomes one `{ event }` line after the reply, in order: the events before the reply wait for it. `end` ends the
 * connection once the reply and the events before it are written. A watch that fails sends no event.
 */
async function serveEntryWatch(
	served: Extract<EntryRequest, { watch: unknown }>,
	request: EntryLine,
	signal: AbortSignal,
	connection: Connection,
): Promise<JsonValue> {
	const { socket } = connection;
	/** The events that wait for the reply, until it is written. */
	let waiting: JsonValue[] | undefined = [];
	let ended = false;

	const write = (event: JsonValue) => {
		if (socket.writable) socket.write(`${JSON.stringify({ event })}\n`);
	};

	const close = () => {
		if (socket.writable) socket.end();
	};

	const emit = (event: JsonValue) => {
		if (ended) return;

		if (waiting === undefined) write(event);
		else waiting.push(event);
	};

	const end = () => {
		if (ended) return;
		ended = true;

		if (waiting === undefined) close();
	};

	let state: JsonValue;

	try {
		state = await served.watch(request, { signal, emit, end });
	} catch (error) {
		ended = true;
		throw error;
	}

	connection.afterReply(() => {
		const events = waiting ?? [];
		waiting = undefined;

		for (const event of events) write(event);

		if (ended) close();
	});

	return state;
}
