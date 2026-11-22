/** The documents of the session of the project in `durable.sqlite` that its modules share. */
import type { JsonObject } from "@earendil-works/pi-durable";
import * as durable from "@earendil-works/pi-durable";
import { boundedReplay } from "../host/checkpoint.ts";

/** A document of the session of the kind `kind`, which starts as `initial()`. */
export function sessionDoc<T extends JsonObject>(kind: string, initial: () => T) {
	return durable.defineDoc<T>({ kind, version: 1, scope: "session", checkpointWhen: boundedReplay, initial });
}
