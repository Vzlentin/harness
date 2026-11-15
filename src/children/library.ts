/**
 * The children library: creates and drives child conversations on whatever pi-durable store its caller hands it. Its
 * caller passes its pi-durable module, so a process never holds two copies.
 */
import { type Context, withCancel } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Models } from "@earendil-works/pi-ai/models";
import type * as Durable from "@earendil-works/pi-durable";
import type {
	AgentChange,
	CommitChange,
	Conversation,
	ConversationId,
	DocumentReader,
	EntryId,
	Extension,
	InputSubmissionDraft,
	JsonObject,
	RegistrySnapshot,
	Submission,
	SubmissionDraft,
	SubmissionId,
	TaskId,
	ToolRegistration,
	Tx,
	UsageState,
} from "@earendil-works/pi-durable";
import { MEMORY_EXTENSION } from "../protocol/project.ts";
import { resolveModel } from "./model.ts";
import { mergeOverlay, type Overlay, overlayDoc, resolveOverlay } from "./overlay.ts";
import { complete, createAnswers } from "./respond.ts";
import { addUsageState } from "./usage.ts";

export { type ResolvedModel, resolveModel } from "./model.ts";

/**
 * The deepest depth of a depth budget whose first spec gives no `limit`, such as one of a library caller: a child of a
 * child of a root.
 */
export const DEFAULT_DEPTH_LIMIT = 2;

/**
 * The tools that open children: `subagent` of `src/tool.ts`, and the `workflow` tool of workflows. A child at the limit
 * of its depth budget is a leaf and gets neither.
 */
const DELEGATION_TOOLS = ["subagent", "workflow"];

/**
 * The store children live in: a Harness, or a running task's runtime with the Harness's `submission`. `commit`
 * callbacks return nothing, as a task's do, and read back through `tx` or `snapshot`.
 */
export type Store = {
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<void>;
	readonly snapshot: DocumentReader["snapshot"];
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
	submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
};

/** Where children live: the store, the models they run on, and the tools that `Spec.tools` names. */
export type Place = {
	readonly store: Store;
	readonly models: Models;
	/** The tools that `Spec.tools` names resolve among, by name; the last of a name wins. */
	readonly registry: RegistrySnapshot;
};

/**
 * Who owns a child, which decides what aborts reach it: a running task in `conversation`, whose abort aborts the child,
 * or an anchor task of its own in `root`, the store's root conversation, so the child outlives every request. The
 * owner's conversation gives the spec what it leaves out. A task owner with a `group` finds the children of every task
 * of that group, such as the tasks of one workflow run across resumes; an abort still reaches only the children that
 * its own task opened.
 */
export type Owner =
	| { readonly kind: "task"; readonly taskId: TaskId; readonly conversation: ConversationId; readonly group?: string }
	| { readonly kind: "detached"; readonly root: Conversation };

/** What a child runs with. JSON only, so a socket can carry it. A field left out comes from the owner's agent. */
export type Spec = (
	| {
			/** The root of the tree, for a child of a caller outside this store: a Pi session, a caller name. */
			readonly root: string;
			readonly parent?: never;
	  }
	| {
			/**
			 * The tree parent, a conversation in this store. The end, `ChildDoc.children`, the overlay that the child
			 * inherits and `Lineage.parent` follow it. It also gives the depth budget, unless `depthRoot` or `depthParent` is
			 * set.
			 */
			readonly parent: string;
			readonly root?: never;
	  }
) &
	(
		| {
				/**
				 * The child starts a new depth budget at depth 0, with `limit`, and stays under its tree parent for the end and
				 * the viewer. For the sessions that a script opens in code.
				 */
				readonly depthRoot?: true;
				readonly depthParent?: never;
		  }
		| {
				/**
				 * The conversation whose depth budget the child takes in place of the tree parent's: one deeper, with its limit.
				 * A conversation that the library did not open counts as depth 0.
				 */
				readonly depthParent: string;
				readonly depthRoot?: never;
		  }
	) & {
		readonly provider?: string;
		readonly model?: string;
		readonly thinking?: string;
		/** The level used without `thinking`, clamped to the nearest level that the model has, not refused. */
		readonly fallbackThinking?: string;
		readonly cwd?: string;
		/** The only tools the child gets, by name. */
		readonly tools?: readonly string[];
		readonly instructions?: string;
		/**
		 * The deepest depth of a new depth budget: for a depth root, or a child whose depth parent the library did not open.
		 * A child of a child keeps the limit of its depth parent. Default `DEFAULT_DEPTH_LIMIT`. A child at the limit is a
		 * leaf: it gets no `subagent` and no `workflow` tool, also when `tools` names them.
		 */
		readonly limit?: number;
		/**
		 * Files that the child sees in place of the disk, by path, relative to `cwd`: a string replaces the file, null
		 * removes it. They change the project instructions, the skills and the `read` tool; the other tools see the disk. A
		 * child of a parent with an overlay gets that overlay too, copied when the child is created; its own paths win.
		 */
		readonly overlay?: Overlay;
	};

/** Where a child sits in its tree and in its depth budget. */
export type Lineage = {
	readonly key: string;
	readonly root: string;
	/** The tree parent. */
	readonly parent?: string;
	/** 1 for a child of a root, and 0 for a depth root. */
	readonly depth: number;
	/** The deepest depth of the depth budget. */
	readonly limit: number;
};

/**
 * What a turn returns: its text, or a named failure. `cut` stopped before its end, such as at its length limit, and
 * keeps its text. `no-respond` is a schema ask with no accepted `respond` call. `unanswered` settled with no answer,
 * after a provider error, an abort or an end; `cause` is the settlement's reason, or `queued` when the child stopped
 * with the request still queued after a failed turn.
 */
export type Answer = (Ok & { readonly value?: JsonValue }) | Failure;

/** A turn that reached its end. */
export type Ok = { readonly status: "ok"; readonly text: string; readonly entry: EntryId };

/** A turn without an answer that counts. */
export type Failure =
	| {
			readonly status: "failed";
			readonly reason: "cut";
			readonly text: string;
			readonly entry: EntryId;
			readonly stopReason: string;
	  }
	| { readonly status: "failed"; readonly reason: "no-respond"; readonly text: string; readonly entry: EntryId }
	| {
			readonly status: "failed";
			readonly reason: "unanswered";
			readonly cause: string;
			readonly detail?: JsonValue | undefined;
	  };

/** The state of a conversation's turns. */
export type TurnState = "busy" | "idle" | "error";

/** The state of a child: the state of its turns, or `ended` from its end until its next input. */
export type State = TurnState | "ended";

/** Input to a child, at most once per request ID. */
export type Input = InputSubmissionDraft & { readonly requestId: string };

/**
 * A passive entry for a child's transcript, at most once per request ID, through `Child.conversation.submit`. It starts
 * no turn: an idle child places it at once, and a busy child at its next boundary. It does not change the last request,
 * and an ended child takes it and stays ended.
 */
export type Write = Extract<SubmissionDraft, { type: "write" }> & { readonly requestId: string };

/** One child, driven by its operations. Failures are returned, not thrown, so each caller keeps its own policy. */
export type Child = {
	readonly id: ConversationId;
	readonly lineage: Lineage;
	/** The child's conversation, for what the library does not cover: its agent, a watch, an abort of its turn. */
	readonly conversation: Conversation;
	/**
	 * Admits `input` and returns. A request ID admitted before is not admitted again. A new request ID resumes an ended
	 * child, and only that child: its ended children stay ended. The commit after the submit makes the request the last
	 * request, unless a newer submission already is, and runs `admitted`. A crash between the submit and that commit
	 * leaves the last request as it was; a repeat of the request runs the commit. An end that comes between the submit
	 * and that commit aborts the new input, and the send fails. A send while a schema ask runs turns `respond` off, so
	 * that ask gives `no-respond` unless `respond` already saved its answer.
	 */
	send(input: Input, context: Context, options?: { readonly admitted?: (tx: Tx) => Promise<void> }): Promise<void>;
	/**
	 * Admits `input` as `send` does, for a caller that waits for no answer, such as a user answer to a conversation that a
	 * task owns: it prepares no answer and does not change the last request. A new request ID resumes an ended child, and
	 * an end during the submit aborts the new input, and the call fails.
	 */
	input(input: Input, context: Context): Promise<void>;
	/**
	 * Sends `input` as one turn and gives its answer. A request ID answered before gives its saved answer with no new
	 * turn. A request ID that was not answered, or whose answer does not count, is sent again as `<requestId>#2`, `#3`
	 * and so on. With `schema`, the child must answer through its `respond` tool with a value that matches the schema,
	 * which becomes `value`; else the answer is `no-respond`. A child opened with `Spec.tools` has no `respond`, so its
	 * schema asks give `no-respond`. A new request ID resumes an ended child as `send` does, and cancelling `context`
	 * stops only the wait.
	 */
	ask(
		input: Input,
		context: Context,
		options: { readonly schema: JsonObject },
	): Promise<(Ok & { readonly value: JsonValue }) | Failure>;
	ask(input: Input, context: Context, options?: { readonly schema?: undefined }): Promise<Ok | Failure>;
	ask(input: Input, context: Context, options?: { readonly schema?: JsonObject }): Promise<Answer>;
	/**
	 * Waits until `request` (default: the last one) settles, then gives its answer. Cancelling the wait through
	 * `context` stops only the wait; the child runs until `close()` ends it.
	 */
	settled(context: Context, request?: string): Promise<Answer>;
	/** The newest request ID admitted, which `settled` waits for by default, or null before the first one. */
	lastRequest(context: Context): Promise<string | null>;
	state(context: Context): Promise<State>;
	/** The spend of the child and everything under it, for reports. */
	usage(context: Context): Promise<UsageState>;
	/**
	 * Ends the child and its subtree: marks them ended in one commit, then withdraws their queued input and aborts them,
	 * background work included. A child stays ended until its next input. A repeat finishes the aborts of an end that
	 * stopped. Gives the conversations it ended, parents first. With `below`, it does this only for the subtree under the
	 * child, and the child keeps its state; with `alone`, only for the child, and its subtree keeps its state. A turn of
	 * the child's conversation that a task outside the child's owner sent, such as a later task of its group, is aborted
	 * only through `conversation.abort`.
	 */
	close(context: Context, options?: { readonly below: true } | { readonly alone: true }): Promise<ConversationId[]>;
};

export type Children = {
	/** The extension with the library's anchor task; the caller installs it in its registry. */
	readonly extension: Extension;
	/**
	 * The extension with `respond` for schema asks; the caller installs it in its registry. Each child selects it, so
	 * the caller does not.
	 */
	readonly answerExtension: Extension;
	/**
	 * The child of `key`: created the first time `key` is seen, with its lineage, in one commit, and the same child after.
	 * `setup` runs in the creating commit. Before creating anything, it refuses a spec whose model neither it nor the
	 * owner's agent names, an unknown model or tool, and a child deeper than its limit. A child under an ended parent is
	 * created, and the parent stays ended. A child at its limit gets no `subagent` and no `workflow` tool. Keys are
	 * global in a store, so callers prefix them.
	 */
	open(
		place: Place,
		owner: Owner,
		key: string,
		spec: Spec,
		context: Context,
		setup?: (tx: Tx, id: ConversationId) => Promise<void>,
	): Promise<Child>;
	/**
	 * The child of `owner` with a key or a conversation ID opened earlier, also after a restart. A child of another
	 * owner is refused.
	 */
	find(
		place: Place,
		owner: Owner,
		which: { readonly key: string } | { readonly id: string },
		context: Context,
	): Promise<Child | undefined>;
	/**
	 * The lineage, conversation, state and input of the child with the conversation ID `id`, of any owner, without its
	 * other owner operations. Nothing for a root, an unknown ID, or text that is not an ID.
	 */
	inspect(
		place: Place,
		id: string,
		context: Context,
	): Promise<Pick<Child, "lineage" | "conversation" | "state" | "input"> | undefined>;
	/** Where the conversation `id` sits in its tree; nothing for a root, or another conversation the library did not open. */
	lineage(store: Pick<Store, "snapshot">, id: string, context: Context): Promise<Lineage | undefined>;
	/**
	 * The `send` and `state` of `Child` for any conversation, with its last request in `last`. As for `Child.send`, the
	 * commit after the submit writes the request as the last request, unless a newer submission already is. `state` is
	 * never `ended`.
	 */
	turn(place: Place, id: ConversationId, conversation: Conversation, last: LastRequest): Turn;
};

/** Where `Children.turn` keeps the last request of a conversation. */
export type LastRequest = {
	read(tx: Tx): Promise<string | null>;
	write(tx: Tx, requestId: string): Promise<void>;
};

/** The input and the state of one conversation, as `Children.turn` gives them. */
export type Turn = {
	send(input: Input, context: Context): Promise<void>;
	state(context: Context): Promise<TurnState>;
};

type OwnerState = { kind: "task"; taskId: number; group?: string } | { kind: "detached" };

/** The kind of the document of each conversation that the library opened, with its lineage, owner and state. */
export const CHILD_DOC_KIND = "pi-subagent.child";

type ChildDocState = {
	key: string;
	root: string;
	parent: string | null;
	depth: number;
	limit: number;
	owner: OwnerState;
	/** The children of this child, in creation order. */
	children: ConversationId[];
	/** The newest request ID admitted, which `settled` defaults to. */
	lastRequest: string | null;
	/** Ended until the next input. */
	closed: boolean;
};

/**
 * Whether the child `id` is ended after `change`, a change of its document, such as the commit that ends or resumes it.
 * Nothing for another change.
 */
export function endAfter(change: CommitChange, id: ConversationId): boolean | undefined {
	if (change.type !== "document" || change.kind !== "change") return undefined;

	if (change.record.kind !== CHILD_DOC_KIND || change.conversationId !== id) return undefined;

	// SAFETY: only `ChildDoc` has the kind `CHILD_DOC_KIND`, and its value is a `ChildDocState`.
	return (change.value as ChildDocState).closed;
}

export function createChildren(durable: typeof Durable): Children {
	const ChildDoc = durable.defineDoc<ChildDocState>({
		kind: CHILD_DOC_KIND,
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		checkpointWhen: () => false,
		initial: () => ({
			key: "",
			root: "",
			parent: null,
			depth: 0,
			limit: 0,
			owner: { kind: "detached" },
			children: [],
			lastRequest: null,
			closed: false,
		}),
	});

	const OverlayDoc = overlayDoc(durable);

	/** The conversation of each key; null before it exists. */
	const Keys = durable.defineDocFamily<{ conversation: ConversationId | null }, null>({
		kind: "pi-subagent.key",
		version: 1,
		scope: "session",
		checkpointWhen: () => false,
		family: true,
		initial: () => ({ conversation: null }),
	});

	/**
	 * Owns a detached child's conversation. It is a background task of the root conversation that finishes at once, so
	 * the child outlives any one request and only an abort with `background: true` reaches it.
	 */
	const Anchor = durable.defineTask<null, { phase: "done" }, null>({
		name: "subagent.anchor",
		version: 1,
		initial: () => ({ phase: "done" }),
		phases: {
			done: (_anchor, runtime, taskContext) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
		},
		abort: (_anchor, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
	});

	const answers = createAnswers(durable);
	const extension = durable.defineExtension({ name: "pi-subagent-children", tasks: [Anchor] });

	const ownerState = (owner: Owner): OwnerState =>
		owner.kind === "detached"
			? { kind: "detached" }
			: owner.group === undefined
				? { kind: "task", taskId: owner.taskId }
				: { kind: "task", taskId: owner.taskId, group: owner.group };

	const sameOwner = (a: Readonly<OwnerState>, b: OwnerState) => {
		if (a.kind === "detached" || b.kind === "detached") return a.kind === b.kind;

		return a.group !== undefined || b.group !== undefined ? a.group === b.group : a.taskId === b.taskId;
	};

	const lineageOf = (doc: Readonly<ChildDocState>): Lineage => {
		const found: Lineage = { key: doc.key, root: doc.root, depth: doc.depth, limit: doc.limit };

		return doc.parent === null ? found : { ...found, parent: doc.parent };
	};

	async function lineage(store: Pick<Store, "snapshot">, id: string, context: Context) {
		const conversation = conversationIdOf(id);
		const doc = conversation === undefined ? undefined : await store.snapshot(ChildDoc, conversation, context);

		return doc === undefined ? undefined : lineageOf(doc);
	}

	/** Commits `change` and gives back its value, because `Store.commit` returns nothing on a task's runtime. */
	async function commitFor<T>(place: Place, change: (tx: Tx) => Promise<T>, context: Context): Promise<T> {
		let result: { readonly value: T } | undefined;
		await place.store.commit(async (tx) => {
			result = { value: await change(tx) };

			return undefined;
		}, context);

		if (result === undefined) throw new Error("The commit did not run its change");

		return result.value;
	}

	/** `id` and every child under it, parents first. */
	async function subtree(place: Place, id: ConversationId, context: Context): Promise<ConversationId[]> {
		const ids = [id];

		// The loop also visits the IDs that it appends.
		for (const member of ids) {
			const doc = await place.store.snapshot(ChildDoc, member, context);

			for (const child of doc?.children ?? []) ids.push(child);
		}

		return ids;
	}

	/** The answer of the settled input `request` of `id`. */
	async function answerIn(tx: Tx, id: ConversationId, request: string): Promise<Ok | Failure> {
		const settled = await tx.submissionByRequest(id, request);

		if (settled?.status === "unanswered") {
			return { status: "failed", reason: "unanswered", cause: settled.reason, detail: settled.detail };
		}

		if (settled?.status !== "done") return { status: "failed", reason: "unanswered", cause: "queued" };
		const entry = settled.answer;

		if (entry === undefined) return { status: "failed", reason: "unanswered", cause: "missing answer" };
		const message = (await tx.entry(durable.AssistantEntry, entry))?.model?.[0];

		if (message?.role !== "assistant") return { status: "failed", reason: "unanswered", cause: "missing answer" };

		const text = message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();

		if (!complete(message.stopReason)) {
			return { status: "failed", reason: "cut", text, entry, stopReason: message.stopReason };
		}

		return { status: "ok", text, entry };
	}

	/**
	 * Makes the admitted `requestId` the last request of `id`, unless the current one has a newer submission, so a
	 * repeat of an older request does not move it back.
	 */
	async function setLast(tx: Tx, id: ConversationId, last: LastRequest, requestId: string): Promise<void> {
		const current = await last.read(tx);

		if (current === requestId) return;
		const now = current === null ? undefined : await tx.submissionByRequest(id, current);
		const submission = await tx.submissionByRequest(id, requestId);

		if (submission === undefined || (now !== undefined && now.id > submission.id)) return;
		await last.write(tx, requestId);
	}

	const turn: Children["turn"] = (place, id, conversation, last) => ({
		async send(input, context) {
			await conversation.submit(input, context);
			await place.store.commit(async (tx) => {
				await setLast(tx, id, last, input.requestId);

				return undefined;
			}, context);
		},
		async state(context) {
			const live = await place.store.snapshot(durable.LiveDoc, id, context);

			if (live?.run !== undefined) return "busy";

			// One commit for both reads: the store reads a submission by request ID only in a commit.
			const settled = await commitFor(
				place,
				async (tx) => {
					const requestId = await last.read(tx);

					return requestId == null ? undefined : tx.submissionByRequest(id, requestId);
				},
				context,
			);

			// A request that is admitted and not answered yet makes the child busy before its run starts.
			if (settled?.status === "queued" || settled?.status === "placed") return "busy";

			// An aborted turn leaves the conversation idle.
			return settled?.status === "unanswered" && settled.reason !== "aborted" ? "error" : "idle";
		},
	});

	function makeChild(place: Place, id: ConversationId, childLineage: Lineage, conversation: Conversation): Child {
		const lastRequest = async (context: Context) => (await place.store.snapshot(ChildDoc, id, context))?.lastRequest;

		const last: LastRequest = {
			read: async (tx) => (await tx.doc(ChildDoc, id)).lastRequest,
			write: async (tx, requestId) => {
				(await tx.doc(ChildDoc, id)).lastRequest = requestId;
			},
		};

		const turns = turn(place, id, conversation, last);

		/**
		 * The commit step of a new request ID: clears the end of this child only, not of its children. Gives false for a
		 * request ID admitted before, which changes nothing.
		 */
		const admitNew = async (tx: Tx, requestId: string) => {
			if ((await tx.submissionByRequest(id, requestId)) !== undefined) return false;
			const doc = await tx.doc(ChildDoc, id);

			if (doc.closed) doc.closed = false;

			return true;
		};

		/**
		 * Submits `input`, then runs `after` in a commit. pi-durable admits a submission in a commit of its own, so the
		 * commit that resumed the child cannot share it. An end during the submit of a `fresh` input, a new request ID,
		 * did not abort the new submission, so the child is aborted again and the call fails: no ended child is busy. A
		 * repeated request ID runs `after` whatever the end.
		 */
		const admitToChild = async (input: Input, fresh: boolean, after: (tx: Tx) => Promise<void>, context: Context) => {
			await conversation.submit(input, context);

			const ended = await commitFor(
				place,
				async (tx) => {
					if (fresh && (await tx.doc(ChildDoc, id)).closed) return true;
					await after(tx);

					return false;
				},
				context,
			);

			if (ended) {
				await conversation.abort(context, { background: true });
				throw new Error(`The child ${id} ended during the submit`);
			}
		};

		/** Makes `requestId` the last request and records its submission for the current ask. */
		const recordAdmission = async (tx: Tx, requestId: string) => {
			await setLast(tx, id, last, requestId);
			await answers.recordSubmission(tx, id, requestId);
		};

		/** `answer` of the turn `attempt`, with the `respond` answer of a schema ask, or `no-respond` without one. */
		const withRespond = async (answer: Answer, attempt: string, schema: JsonObject | undefined, context: Context) => {
			if (schema === undefined || answer.status !== "ok") return answer;
			const value = await commitFor(place, (tx) => answers.valueIn(tx, id, attempt), context);

			if (value === undefined) {
				return { status: "failed", reason: "no-respond", text: answer.text, entry: answer.entry } as const;
			}

			return { ...answer, value };
		};

		const settled = async (context: Context, request?: string): Promise<Ok | Failure> => {
			const requestId = request ?? (await lastRequest(context));

			if (requestId == null) return { status: "failed", reason: "unanswered", cause: "no request" };
			const record = await commitFor(place, (tx) => tx.submissionByRequest(id, requestId), context);

			if (record === undefined) return { status: "failed", reason: "unanswered", cause: "no request" };
			const submission = await place.store.submission(record.id, context);
			// A request still queued when the child stops after a failed turn never settles, so idle ends the wait too.
			const wait = withCancel(context);

			try {
				await Promise.race([
					...(submission === undefined ? [] : [submission.wait(wait.context)]),
					conversation.waitForIdle(wait.context),
				]);
			} finally {
				wait.cancel();
			}

			context.abortSignal?.throwIfAborted();

			return commitFor(place, (tx) => answerIn(tx, id, requestId), context);
		};

		function ask(
			input: Input,
			context: Context,
			options: { readonly schema: JsonObject },
		): Promise<(Ok & { readonly value: JsonValue }) | Failure>;
		function ask(input: Input, context: Context, options?: { readonly schema?: undefined }): Promise<Ok | Failure>;
		function ask(input: Input, context: Context, options?: { readonly schema?: JsonObject }): Promise<Answer>;
		async function ask(
			input: Input,
			context: Context,
			options?: { readonly schema?: JsonObject | undefined },
		): Promise<Answer> {
			const schema = options?.schema;
			let attempt = input.requestId;
			let saved: Answer | undefined;
			let fresh = false;
			await place.store.commit(async (tx) => {
				let record = await tx.submissionByRequest(id, attempt);

				for (let n = 2; record !== undefined; n++) {
					if (record.status === "done") {
						const answer = await answerIn(tx, id, attempt);
						const value = schema === undefined ? undefined : await answers.valueIn(tx, id, attempt);

						if (answer.status === "ok" && (schema === undefined || value !== undefined)) {
							saved = value === undefined ? answer : { ...answer, value };

							return undefined;
						}
					} else if (record.status !== "unanswered") break;
					attempt = `${input.requestId}#${n}`;
					record = await tx.submissionByRequest(id, attempt);
				}

				fresh = record === undefined;

				// A request that is still pending keeps its ask.
				if (fresh) {
					await admitNew(tx, attempt);
					await answers.prepare(tx, id, attempt, schema);
				}

				return undefined;
			}, context);

			if (saved !== undefined) return saved;
			const request = { ...input, requestId: attempt };
			await admitToChild(request, fresh, (tx) => recordAdmission(tx, request.requestId), context);

			return withRespond(await settled(context, attempt), attempt, schema, context);
		}

		return {
			id,
			lineage: childLineage,
			conversation,
			async send(input, context, options) {
				const fresh = await commitFor(
					place,
					async (tx) => {
						const admitted = await admitNew(tx, input.requestId);

						if (admitted) await answers.prepare(tx, id, input.requestId);

						return admitted;
					},
					context,
				);

				const after = async (tx: Tx) => {
					await recordAdmission(tx, input.requestId);
					await options?.admitted?.(tx);
				};

				await admitToChild(input, fresh, after, context);
			},
			async input(input, context) {
				const fresh = await commitFor(place, (tx) => admitNew(tx, input.requestId), context);
				await admitToChild(input, fresh, async () => {}, context);
			},
			ask,
			settled,
			lastRequest: async (context) => (await lastRequest(context)) ?? null,
			async state(context) {
				if ((await place.store.snapshot(ChildDoc, id, context))?.closed === true) return "ended";

				return turns.state(context);
			},
			async usage(context) {
				const sum: UsageState = { models: {}, tools: {} };

				for (const member of await subtree(place, id, context)) {
					const usage = await place.store.snapshot(durable.UsageDoc, member, context);

					if (usage !== undefined) addUsageState(sum, usage);
				}

				return sum;
			},
			async close(context, options) {
				// One commit reads the subtree and marks it, so a child that `open` adds under it is either marked or added after.
				const ids = await commitFor(
					place,
					async (tx) => {
						const members = [id];
						const alone = options !== undefined && "alone" in options;

						// The loop also visits the IDs that it appends.
						for (const member of alone ? [] : members) {
							members.push(...(await tx.doc(ChildDoc, member)).children);
						}

						const ending = members.slice(options !== undefined && "below" in options ? 1 : 0);

						for (const member of ending) (await tx.doc(ChildDoc, member)).closed = true;

						return ending;
					},
					context,
				);

				for (const member of ids) {
					await (await place.store.conversation(member, context))?.abort(context, { background: true });
				}

				return ids;
			},
		};
	}

	/** The child of a key or a conversation ID, of any owner, with its document. */
	async function load(
		place: Place,
		which: { readonly key: string } | { readonly id: string },
		context: Context,
	): Promise<{ child: Child; owner: Readonly<OwnerState> } | undefined> {
		const id =
			"key" in which
				? (await place.store.snapshot(Keys, which.key, context))?.conversation
				: conversationIdOf(which.id);

		if (id === undefined || id === null) return undefined;
		const doc = await place.store.snapshot(ChildDoc, id, context);
		const conversation = await place.store.conversation(id, context);

		if (doc === undefined || conversation === undefined) return undefined;

		return { child: makeChild(place, id, lineageOf(doc), conversation), owner: doc.owner };
	}

	const find: Children["find"] = async (place, owner, which, context) => {
		const loaded = await load(place, which, context);

		if (loaded === undefined) return undefined;

		if (!sameOwner(loaded.owner, ownerState(owner))) {
			throw new Error(`The child ${loaded.child.id} belongs to another owner`);
		}

		return loaded.child;
	};

	const inspect: Children["inspect"] = async (place, id, context) => (await load(place, { id }, context))?.child;

	return {
		extension,
		answerExtension: answers.extension,
		lineage,
		find,
		inspect,
		turn,
		async open(place, owner, key, spec, context, setup) {
			const existing = await find(place, owner, { key }, context);

			if (existing !== undefined) return existing;

			const ownerConversation =
				owner.kind === "task" ? await place.store.conversation(owner.conversation, context) : owner.root;

			const agent = await ownerConversation?.agent(context);
			const { model, thinkingLevel } = resolveModel(place.models, agent, spec);
			const cwd = spec.cwd ?? agent?.cwd;
			const own = spec.overlay === undefined ? undefined : resolveOverlay(spec.overlay, cwd);
			let tools: ToolRegistration[] | undefined;

			if (spec.tools !== undefined) {
				const installed = place.registry.tools();
				tools = spec.tools.map((name) => {
					const found = installed.findLast(({ tool }) => tool.name === name);

					if (found === undefined) throw new Error(`Unknown tool: ${name}`);

					return found.tool;
				});
			}

			const parentId = spec.parent === undefined ? undefined : conversationIdOf(spec.parent);
			const parent = spec.parent === undefined ? undefined : await lineage(place.store, spec.parent, context);

			const inherited =
				parentId === undefined ? undefined : (await place.store.snapshot(OverlayDoc, parentId, context))?.files;

			const overlay = own !== undefined && inherited !== undefined ? mergeOverlay(inherited, own) : (own ?? inherited);
			let budget = parent;

			if (spec.depthRoot === true) budget = undefined;
			else if (spec.depthParent !== undefined) budget = await lineage(place.store, spec.depthParent, context);
			const depth = spec.depthRoot === true ? 0 : (budget?.depth ?? 0) + 1;
			const limit = budget?.limit ?? spec.limit ?? DEFAULT_DEPTH_LIMIT;

			if (depth > limit) throw new Error("Nested subagents are disabled");
			const root = spec.parent === undefined ? spec.root : (parent?.root ?? spec.parent);

			const create = async (tx: Tx, ownerTask: TaskId) => {
				const known = await tx.doc(Keys, key, null);

				if (known.conversation !== null) return undefined;

				const child = await tx.createConversation({ ownership: { kind: "task", taskId: ownerTask } });
				let change: AgentChange = { model, thinkingLevel };

				if (cwd !== undefined) change = { ...change, cwd };

				if (tools !== undefined) change = { ...change, tools };

				if (spec.instructions !== undefined) change = { ...change, instructions: spec.instructions };
				await durable.configure(tx, child.id, change);
				// The child keeps the extensions of the owner's agent and selects the answer extension too.
				// No child, at any depth, gets the memory of the project agent: neither its tool nor its section.
				const agent = await tx.doc(durable.AgentDoc, child.id);
				const answerName = answers.extension.name;
				const selection = agent.extensions;

				if (Array.isArray(selection)) {
					const kept = selection.filter((name) => name !== MEMORY_EXTENSION);
					agent.extensions = kept.includes(answerName) ? kept : [...kept, answerName];
				} else {
					agent.extensions = {
						...selection,
						add: [...new Set([...(selection?.add ?? []), answerName])],
						remove: [...new Set([...(selection?.remove ?? []), MEMORY_EXTENSION])],
					};
				}

				// A leaf: the filter of the enabled tools covers both the model and codemode.
				if (depth === limit) {
					const enabled = agent.tools;

					if (Array.isArray(enabled)) {
						agent.tools = enabled.filter((name) => !DELEGATION_TOOLS.includes(name));
					} else {
						agent.tools = { remove: [...new Set([...(enabled?.remove ?? []), ...DELEGATION_TOOLS])] };
					}
				}

				const state: ChildDocState = {
					key,
					root,
					parent: spec.parent ?? null,
					depth,
					limit,
					owner: ownerState(owner),
					children: [],
					lastRequest: null,
					closed: false,
				};

				Object.assign(await tx.doc(ChildDoc, child.id), state);

				if (overlay !== undefined) (await tx.doc(OverlayDoc, child.id)).files = overlay;

				// A parent that the library opened lists the child, so the end of the parent ends it too.
				if (parent !== undefined && parentId !== undefined) (await tx.doc(ChildDoc, parentId)).children.push(child.id);
				known.conversation = child.id;
				await setup?.(tx, child.id);

				return undefined;
			};

			if (owner.kind === "detached") {
				await owner.root.commit(async (tx) => {
					if ((await tx.doc(Keys, key, null)).conversation !== null) return undefined;
					const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });

					return create(tx, anchor);
				}, context);
			} else {
				await place.store.commit((tx) => create(tx, owner.taskId), context);
			}

			const opened = await find(place, owner, { key }, context);

			if (opened === undefined) throw new Error(`The child of ${key} is missing`);

			return opened;
		},
	};
}

/** The conversation ID that `value` spells, as callers write it; nothing for another caller, such as a Pi session. */
function conversationIdOf(value: string): ConversationId | undefined {
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return undefined;

	// SAFETY: a conversation ID is a positive safe integer, and the callers look up the conversation of this one.
	return Number(value) as ConversationId;
}
