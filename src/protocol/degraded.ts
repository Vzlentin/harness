/** The degraded states of a host: the kinds, and a state with its line for the user. */
import { type Static, Type } from "typebox";
import { Text, Time } from "./asks.ts";

/**
 * The kinds of the degraded states of a host: the gate classifier failed (`gate-classifier`), a classifier setting has
 * no model with a credential (`no-classifier`), a package or an entry was skipped at the start (`package-skipped`,
 * `entry-skipped`), a push of answers failed and waits (`push-failed`), the tell of an approved action failed
 * (`approve-tell`), answers of the user wait for an asker with no open `answers` request (`answer-waits`), the awake
 * hold failed (`awake-failed`), a catch-up or a digest failed (`catch-up-failed`, `digest-failed`), and the project
 * instructions and skills of a directory failed to load (`resources-failed`). An entry, such as the projects entry,
 * starts the states of the gate, of the approve and of the digest through the `degraded` handle.
 */
export const DEGRADED_KINDS = [
	"gate-classifier",
	"no-classifier",
	"package-skipped",
	"entry-skipped",
	"push-failed",
	"approve-tell",
	"answer-waits",
	"awake-failed",
	"catch-up-failed",
	"digest-failed",
	"resources-failed",
] as const;

export const DegradedKind = Type.Enum(DEGRADED_KINDS);

export type DegradedKind = Static<typeof DegradedKind>;

/** A degraded state of the host: its kind, a line for the user, and the time of its start in epoch milliseconds. */
export const DegradedState = Type.Object({ kind: DegradedKind, line: Text, since: Time });

export type DegradedState = Static<typeof DegradedState>;
