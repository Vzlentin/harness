/**
 * The digest of each agent: one line with the messages out of the project that wait, and one line with the held actions
 * of the agent. An agent gets it only when it changed since its last digest, so it reads a thread only when it needs
 * the words.
 */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader, Harness } from "@earendil-works/pi-durable";
import {
	DIGEST_KIND,
	type HeldAction,
	isWaiting,
	type PersonNames,
	personNames,
	type Thread,
} from "../protocol/project.ts";
import { errorMessage } from "../protocol/requests.ts";
import { type OutState, readHeld, readOutbox, readPersons, readThreads, sessionDoc } from "./project.ts";
import type { Found } from "./targets.ts";

const context = BACKGROUND_CONTEXT;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The last digest of each caller: how many digests it got, and the text of the last one. */
type DigestRecord = { count: number; text: string };

const Digests = sessionDoc<{ callers: Record<string, DigestRecord> }>("harness.digests", () => ({ callers: {} }));

/** A digest that a caller gets: its text, the IDs of its messages and held actions, and its request ID. */
export type Digest = {
	readonly text: string;
	readonly count: number;
	readonly requestId: string;
	readonly data: { readonly waits: number[]; readonly held: number[] };
};

/** What the digest uses of the host. */
export type DigestHost = {
	readonly harness: Pick<Harness, "snapshot" | "commit">;
	readonly warn: (cause: unknown) => void;
};

/**
 * The digest of `caller` now, or `undefined` when its text is the text of its last digest, or when the caller never got
 * a digest and nothing waits. The request ID `digest:<count>:<hash>` names its count and its text.
 */
export async function nextDigest(
	harness: Pick<DocumentReader, "snapshot">,
	caller: string,
): Promise<Digest | undefined> {
	const [persons, threads, outbox, held, digests] = await Promise.all([
		readPersons(harness, context),
		readThreads(harness, context),
		readOutbox(harness, context),
		readHeld(harness, context),
		harness.snapshot(Digests, context),
	]);

	const waiting = outbox.filter((out) => isWaiting(out.state));
	const own = held.held.filter((action) => action.state === "held" && action.agent === caller);
	const last = digests?.callers[caller];

	if (last === undefined && waiting.length === 0 && own.length === 0) return undefined;
	const names = personNames(persons);
	const byId = new Map(threads.threads.map((thread) => [thread.id, thread]));
	const text = [waitsLine(waiting, byId, names), heldLine(own)].join("\n");

	if (last?.text === text) return undefined;
	const count = (last?.count ?? 0) + 1;
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);

	return {
		text,
		count,
		requestId: `digest:${count}:${hash}`,
		data: { waits: waiting.map((out) => out.id), held: own.map((action) => action.id) },
	};
}

/** Records `digest` as the last digest of `caller`. */
export async function recordDigest(harness: Pick<Harness, "commit">, caller: string, digest: Digest): Promise<void> {
	await harness.commit(async (tx) => {
		(await tx.doc(Digests)).callers[caller] = { count: digest.count, text: digest.text };
	}, context);
}

/**
 * Writes the digest of the conversation of `target` to it, as a passive entry of the kind `harness.digest`, before
 * an input, then records it. The entry goes first, and its request ID makes a repeat after a crash add nothing. It
 * never throws: a failure is a warning, and the input goes through.
 */
export async function writeDigest(host: DigestHost, target: Pick<Found, "conversation" | "write">): Promise<void> {
	const caller = String(target.conversation.id);

	try {
		const digest = await nextDigest(host.harness, caller);

		if (digest === undefined) return;
		const model = [{ role: "user", content: digest.text, timestamp: Date.now() }] as const;
		await target.write({
			type: "write",
			requestId: digest.requestId,
			entry: { kind: DIGEST_KIND, model, data: digest.data },
		});
		await recordDigest(host.harness, caller, digest);
	} catch (cause) {
		host.warn(`digest: ${errorMessage(cause)}`);
	}
}

/** `waiting on: <persons> (<topic>, sent <time>)` or `(<topic>, draft not sent)` for each message, or `none`. */
function waitsLine(waiting: readonly OutState[], threads: ReadonlyMap<number, Thread>, names: PersonNames): string {
	const items = waiting.map((out) => {
		const thread = threads.get(out.thread);
		const persons = (thread?.persons ?? []).map((id) => names.get(id) ?? `person ${id}`).join(", ");
		const state = out.state === "sent" ? `sent ${shortTime(out.at)}` : "draft not sent";

		return `${persons} (${thread?.topic ?? `thread ${out.thread}`}, ${state})`;
	});

	return `waiting on: ${items.length === 0 ? "none" : items.join(" · ")}`;
}

/** `held: <id> <tool>: <reason>` for each action, or `none`. */
function heldLine(held: readonly HeldAction[]): string {
	const items = held.map((action) => `${action.id} ${action.tool}: ${action.reason}`);

	return `held: ${items.length === 0 ? "none" : items.join(" · ")}`;
}

/** `<day> <month> <HH:MM>`, in UTC, such as `12 Nov 14:22`. */
function shortTime(at: number): string {
	const date = new Date(at);
	const time = date.toISOString().slice(11, 16);

	return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${time}`;
}
