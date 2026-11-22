/**
 * The digest of each agent, in this order: the line `board of <project>: <n> open`; up to 10 lines `○ <id> <title>`,
 * the open items with no open need (no `needs` edge to an open item), in ID order; one `+<n> later` line for the open
 * items that it does not show; one `waiting on:` line with the messages out of the project that wait; and one `held:`
 * line with the held actions of the agent. An agent gets it only when it changed since its last digest, or when its
 * context lost the last one: after a new head of its context, a head marker of a hosted conversation (a compaction or a
 * reset) or a compaction entry of a Pi session. So it reads a thread or an item only when it needs the words.
 */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader, Harness, Storage } from "@earendil-works/pi-durable";
import type { Degraded } from "../host/degraded.ts";
import type { InputHook, InputHookCall } from "../host/entries.ts";
import { ITEM_MARKS, type WorkItem } from "../protocol/item.ts";
import {
	DIGEST_KIND,
	type HeldAction,
	isWaiting,
	type PersonNames,
	personNames,
	type Thread,
} from "../protocol/project.ts";
import { readItems } from "./item-docs.ts";
import { sessionDoc } from "./project-docs.ts";
import type { OutMessage, StoreReader } from "./project-store.ts";

const context = BACKGROUND_CONTEXT;

/** The most open items that the board shows. */
const BOARD_CAP = 10;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The last digest of each caller: how many digests it got, the text of the last one, and the ID of the newest head of
 * its context when it got it.
 */
type DigestRecord = { count: number; text: string; head?: string };

const Digests = sessionDoc<{ callers: Record<string, DigestRecord> }>("harness.digests", () => ({ callers: {} }));

/**
 * A digest that a caller gets: its text, the IDs of its messages and held actions, its key, and the head of its
 * context.
 */
export type Digest = {
	readonly text: string;
	readonly count: number;
	readonly head: string | undefined;
	readonly key: string;
	readonly data: { waits: number[]; held: number[]; items: number[] };
};

/** What the digest uses of the host. */
export type DigestHost = {
	readonly harness: Pick<Harness, "snapshot" | "commit">;
	readonly storage: Pick<Storage, "scanDocuments">;
	/** The project store, with the persons, the threads and the messages out. */
	readonly store: StoreReader;
	readonly project: string;
	readonly degraded: Degraded;
};

/**
 * The digest of `caller` now, or `undefined` when its text and `head` are those of its last digest, or when the caller
 * never got a digest and nothing waits, nothing is held and no item is open. `head` is the ID of the newest head of the
 * context of the caller, so a new head gives the digest again. The key `<count>:<hash>` names its count and its text.
 */
export async function nextDigest(
	host: {
		readonly harness: Pick<DocumentReader, "snapshot">;
		readonly storage: Pick<Storage, "scanDocuments">;
		readonly store: StoreReader;
		readonly project: string;
	},
	caller: string,
	head: string | undefined,
): Promise<Digest | undefined> {
	const { harness, store } = host;
	const persons = { persons: store.persons() };
	const threads = store.threads();
	const outbox = store.outMessages();

	const held = store.held();

	const [open, digests] = await Promise.all([
		readItems(harness, host.storage, "open", context),
		harness.snapshot(Digests, context),
	]);

	const waiting = outbox.filter((out) => isWaiting(out.state));
	const own = held.filter((action) => action.state === "held" && action.agent === caller);
	const last = digests?.callers[caller];

	if (last === undefined && waiting.length === 0 && own.length === 0 && open.length === 0) return undefined;
	const names = personNames(persons);
	const byId = new Map(threads.map((thread) => [thread.id, thread]));
	const shownBoard = board(host.project, open);

	const text = [...shownBoard.lines, waitsLine(waiting, byId, names), heldLine(own)].join("\n");

	if (last?.text === text && last.head === head) return undefined;
	const count = (last?.count ?? 0) + 1;
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);

	return {
		text,
		count,
		head,
		key: `${count}:${hash}`,
		data: {
			waits: waiting.map((out) => out.id),
			held: own.map((action) => action.id),
			items: shownBoard.shown,
		},
	};
}

/** Records `digest` as the last digest of `caller`. */
export async function recordDigest(harness: Pick<Harness, "commit">, caller: string, digest: Digest): Promise<void> {
	await harness.commit(async (tx) => {
		const { count, text, head } = digest;

		(await tx.doc(Digests)).callers[caller] = head === undefined ? { count, text } : { count, text, head };
	}, context);
}

/**
 * The input hook of the digest: before each input of a hosted conversation, it writes the digest of the conversation
 * to it, as a passive entry of the kind `harness.digest` with the request ID `input:digest:<count>:<hash>`, then records
 * it. A new head marker of the conversation since its last digest, a compaction or a reset, gives the digest again. The
 * entry goes first, and its request ID makes a repeat after a crash add nothing. It never throws: a failure is a warning
 * and the degraded state `digest-failed` of the conversation, which its next digest that does not fail ends, and the
 * input goes through. `host` is read at each run, so the hook works once the host is open.
 */
export function digestHook(host: () => DigestHost): InputHook {
	return { kind: "digest", run: (call) => writeDigest(host(), call) };
}

/** Writes the digest of `conversation`, whose newest head is `head`, with `write`, as `digestHook` describes. */
async function writeDigest(host: DigestHost, call: InputHookCall): Promise<void> {
	const { conversation, head } = call;

	await host.degraded.guard("digest-failed", conversation, "digest: ", async () => {
		const digest = await nextDigest(host, conversation, head);

		if (digest === undefined) return;
		await call.write({ key: digest.key, kind: DIGEST_KIND, text: digest.text, data: digest.data });
		await recordDigest(host.harness, conversation, digest);
	});
}

/**
 * The board section of the open items `open` of `project`, and the IDs of the items it shows: the line
 * `board of <project>: <n> open`, one line `○ <id> <title>` for each of the first `BOARD_CAP` open items, in ID order,
 * that have no open need, then `+<n> later` when it hides `n` open items. An open need is a `needs` edge of the item to
 * an open item; an edge to a closed or an unknown item is none.
 */
function board(project: string, open: readonly Readonly<WorkItem>[]) {
	const openRefs = new Set(open.map((item) => `item:${item.id}`));

	const ready = open.filter((item) => !item.edges.some((edge) => edge.kind === "needs" && openRefs.has(edge.to)));

	const shown = ready.slice(0, BOARD_CAP);
	const hidden = open.length - shown.length;

	return {
		lines: [
			`board of ${project}: ${open.length} open`,
			...shown.map((item) => `${ITEM_MARKS.open} ${item.id} ${item.title}`),
			...(hidden > 0 ? [`+${hidden} later`] : []),
		],
		shown: shown.map((item) => item.id),
	};
}

/** `waiting on: <persons> (<topic>, sent <time>)` or `(<topic>, draft not sent)` for each message, or `none`. */
function waitsLine(waiting: readonly OutMessage[], threads: ReadonlyMap<number, Thread>, names: PersonNames): string {
	const items = waiting.map((out) => {
		const thread = threads.get(out.thread);
		const persons = (thread?.persons ?? []).map((id) => names.get(id) ?? `person ${id}`).join(", ");
		const state = out.state === "sent" ? `sent ${shortTime(out.changed.at)}` : "draft not sent";

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
