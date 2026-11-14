/** The check of the payloads of the events of pi-ipython, for the listeners of the host and of Pi. */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { BridgeEvent } from "./kernel.ts";

/**
 * Runs `handle` with each payload of `event` that has the shape `schema`. A payload of another shape gives `warn` the
 * warning of `event`, and does nothing else.
 */
export function onValid<Payload extends TSchema>(
	events: Pick<EventBus, "on">,
	event: BridgeEvent,
	schema: Payload,
	warn: (message: string) => void,
	handle: (payload: Static<Payload>) => void,
): void {
	events.on(event.channel, (payload) => {
		if (!Value.Check(schema, payload)) {
			warn(event.invalid);

			return;
		}

		handle(payload);
	});
}
