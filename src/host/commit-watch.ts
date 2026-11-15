/** A watch of a value that the stored commits change, for a value that pi-durable's watches cannot follow. */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { Watch, type WatchCall, type WatchEnd, type WatchHandle } from "@earendil-works/chord/watch";
import type { CommitChange, Session } from "@earendil-works/pi-durable";

/**
 * A watch whose value is `read` of now, then `after` of each stored commit change for which `after` gives a value.
 * A `null` value is a retired one. Aborting `context` ends it, as does the close of `session`. A throw of its
 * listener ends it, and `closed` gives the error.
 */
export async function watchCommits<T extends JsonValue>(
	session: Pick<Session, "observeCommits">,
	read: () => Promise<T>,
	after: (change: CommitChange) => T | undefined,
	context: Context,
): Promise<WatchHandle<T>> {
	// The observer attaches before the read, so no commit goes between them. The newest value of a commit during the read
	// goes to the watch once it exists: at worst the value of the read again.
	let watch: Watch<T> | undefined;
	let early: { readonly value: T; readonly context: Context } | undefined;
	let ended: WatchEnd | undefined;

	const observation = session.observeCommits({
		advance: (publication, frameContext) => {
			for (const change of publication.changes) {
				const value = after(change);

				if (value === undefined) continue;

				if (watch === undefined) early = { value, context: frameContext };
				else watch.advance(valueCall(value), frameContext);
			}
		},
		end: (end) => {
			if (watch === undefined) ended = end;
			else watch.end(end);
		},
	});

	let value: T;

	try {
		value = await read();
	} catch (error) {
		observation.detach();
		throw error;
	}

	// A throw of the listener ends the watch, and `closed` gives it.
	watch = new Watch<T>(
		value,
		() => observation.detach(),
		() => {},
	);

	if (early !== undefined) watch.advance(valueCall(early.value), early.context);

	if (ended !== undefined) watch.end(ended);

	if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);

	return watch;
}

/** The frame of a watch that replaces its value with `value`, which retires it when it is `null`. */
function valueCall<T extends JsonValue>(value: T): WatchCall<T> {
	return { kind: "value", value, ops: [["r", value]], retired: value === null };
}
