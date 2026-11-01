/**
 * The children library: creates and drives child conversations on whatever pi-durable store its caller hands it. Its
 * caller passes its pi-durable module, so a process never holds two copies.
 */
import type { JsonValue } from "@earendil-works/chord";
import { type Context, withCancel } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type * as Durable from "@earendil-works/pi-durable";
import type {
	Agent,
	AgentChange,
	Conversation,
	ConversationId,
	DocumentReader,
	EntryId,
	Extension,
	JsonObject,
	ModelRef,
	RegistrySnapshot,
	Submission,
	SubmissionId,
	TaskId,
	ToolRegistration,
	Tx,
	UsageState,
} from "@earendil-works/pi-durable";
import { complete, createAnswers } from "./answer.ts";
import { mergeOverlay, type Overlay, overlayDoc, resolveOverlay } from "./overlay.ts";

/** The deepest child of a tree whose first spec gives no `limit`, such as one of a library caller: a child of a child of a root. */
export const DEFAULT_DEPTH_LIMIT = 2;

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
export type Spec = {
	/** The root of the tree, for a child of a caller outside this store: a Pi session, a caller name. */
	readonly root?: string;
	/** The conversation in this store that spawns the child. */
	readonly parent?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: string;
	/** The caller's thinking level, used without `thinking`: the nearest level that the model has, not refused. */
	readonly fallbackThinking?: string;
	readonly cwd?: string;
	/** The only tools the child gets, by name. */
	readonly tools?: readonly string[];
	readonly instructions?: string;
	/**
	 * The deepest depth of a new tree, for a child without a parent in a tree. A child of a child keeps the limit of its
	 * tree. Default `DEFAULT_DEPTH_LIMIT`.
	 */
	readonly limit?: number;
	/**
	 * Files that the child sees in place of the disk, by path, relative to `cwd`: a string replaces the file, null
	 * removes it. They change the project instructions, the skills and the `read` tool; the other tools see the disk. A
	 * child of a parent with an overlay gets that overlay too, copied when the child is created; its own paths win.
	 */
	readonly overlay?: Overlay;
};

/** Where a child sits in its tree. */
export type Lineage = {
	readonly key: string;
	readonly root: string;
	readonly parent?: string;
	/** 1 for a child of a root. */
	readonly depth: number;
	/** The deepest depth of the tree. */
	readonly limit: number;
};

export type ChildState = "busy" | "idle" | "error" | "closed";

/**
 * What a turn returns: its text, or a named failure. `cut` stopped before its end, such as at its length limit, and
 * keeps its text. `no-respond` is a schema ask with no accepted `respond` call. `unanswered` settled with no answer,
 * after a provider error, an abort or a close; `cause` is the settlement's reason, or `queued` when the child stopped
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

/** Input to a child, at most once per request ID. */
export type Input = Parameters<Conversation["submit"]>[0] & { readonly type: "input"; readonly requestId: string };

/** A passive entry for a child's transcript, at most once per request ID. */
export type Write = Extract<Parameters<Conversation["submit"]>[0], { type: "write" }> & { readonly requestId: string };

/** One child, driven by its operations. Failures are returned, not thrown, so each caller keeps its own policy. */
export type Child = {
	readonly id: ConversationId;
	readonly lineage: Lineage;
	/** The child's conversation, for what the library does not cover: its agent, a watch, an abort of its turn. */
	readonly conversation: Conversation;
	/**
	 * Admits `input` and returns. A request ID admitted before is not admitted again, and a closed child refuses input.
	 * The commit after the submit makes the request the last request, unless a newer submission already is, and runs
	 * `admitted`. A crash between the submit and that commit leaves the last request as it was; a repeat of the request
	 * runs the commit. A close that comes between the submit and that commit aborts the new input, and the send fails.
	 * A send while a schema ask runs turns `respond` off, so that ask gives `no-respond` unless `respond` already saved
	 * its answer.
	 */
	send(input: Input, context: Context, options?: { readonly admitted?: (tx: Tx) => Promise<void> }): Promise<void>;
	/**
	 * Admits the passive entry `write` and returns. It starts no turn: an idle child places it at once, and a busy child
	 * at its next boundary. A request ID admitted before is not admitted again, and a closed child refuses it, also when
	 * the close comes during the submit. It does not change the last request.
	 */
	write(write: Write, context: Context): Promise<void>;
	/**
	 * Sends `input` as one turn and gives its answer. A request ID answered before gives its saved answer with no new
	 * turn. A request ID that was not answered, or whose answer does not count, is sent again as `<requestId>#2`, `#3`
	 * and so on. With `schema`, the child must answer through its `respond` tool with a value that matches the schema,
	 * which becomes `value`; else the answer is `no-respond`. A child opened with `Spec.tools` has no `respond`, so its
	 * schema asks give `no-respond`. A closed child refuses input, and cancelling `context` stops only the wait.
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
	 * `context` stops only the wait; the child runs until `close()`.
	 */
	settled(context: Context, request?: string): Promise<Answer>;
	/** The newest request ID admitted, which `settled` waits for by default, or null before the first one. */
	lastRequest(context: Context): Promise<string | null>;
	state(context: Context): Promise<ChildState>;
	/** The spend of the child and everything under it, for reports. */
	usage(context: Context): Promise<UsageState>;
	/**
	 * Marks the child and its subtree closed in one commit, then withdraws their queued input and aborts them, background
	 * work included. A repeat finishes the aborts of a close that stopped. Gives the conversations it closed, parents
	 * first. With `below`, it does this only for the subtree under the child, and the child stays open. A turn of the
	 * child's conversation that a task outside the child's owner sent, such as a later task of its group, is aborted only
	 * through `conversation.abort`.
	 */
	close(context: Context, options?: { readonly below?: boolean }): Promise<ConversationId[]>;
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
	 * owner's agent names, an unknown model or tool, a parent at its depth limit, and a closed parent. Keys are global in
	 * a store, so callers prefix them.
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
	 * The lineage, conversation and state of the child with the conversation ID `id`, of any owner, without its owner
	 * operations. Nothing for a root, an unknown ID, or text that is not an ID.
	 */
	inspect(
		place: Place,
		id: string,
		context: Context,
	): Promise<Pick<Child, "lineage" | "conversation" | "state"> | undefined>;
	/** Where the conversation `id` sits in its tree; nothing for a root, or another conversation the library did not open. */
	lineage(store: Pick<Store, "snapshot">, id: string, context: Context): Promise<Lineage | undefined>;
	/**
	 * The `send` and `state` of `Child` for any conversation, with its last request in `last`. As for `Child.send`, the
	 * commit after the submit writes the request as the last request, unless a newer submission already is. `state` is
	 * never `closed`.
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
	state(context: Context): Promise<Exclude<ChildState, "closed">>;
};

type OwnerState = { kind: "task"; taskId: number; group?: string } | { kind: "detached" };

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
	closed: boolean;
};

export function createChildren(durable: typeof Durable): Children {
	const ChildDoc = durable.defineDoc<ChildDocState>({
		kind: "pi-subagent.child",
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

	/** The conversation of each key; 0 before it exists. */
	const Keys = durable.defineDocFamily<{ conversation: ConversationId | 0 }, null>({
		kind: "pi-subagent.key",
		version: 1,
		scope: "session",
		checkpointWhen: () => false,
		family: true,
		initial: () => ({ conversation: 0 }),
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

	async function childDoc(store: Pick<Store, "snapshot">, id: ConversationId, context: Context) {
		const doc = await store.snapshot(ChildDoc, id, context);

		return doc === undefined || doc.key === "" ? undefined : doc;
	}

	async function lineage(store: Pick<Store, "snapshot">, id: string, context: Context) {
		const conversation = conversationIdOf(id);
		const doc = conversation === undefined ? undefined : await childDoc(store, conversation, context);

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
			const doc = await childDoc(place.store, member, context);

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
			const requestId = await commitFor(place, (tx) => last.read(tx), context);

			const settled =
				requestId == null ? undefined : await commitFor(place, (tx) => tx.submissionByRequest(id, requestId), context);

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

		const refuseClosed = async (tx: Tx) => {
			if ((await tx.doc(ChildDoc, id)).closed) throw new Error(`The child ${id} is closed`);
		};

		/**
		 * Admits `draft` in three steps: the commit `before` when given, the submit, and a commit that refuses a child
		 * that a close reached during the submit and else runs `after`. pi-durable admits a submission in a commit of its
		 * own, so the checks of `before` cannot share it. A close during the submit did not abort the new submission, so
		 * the refusal aborts the child again.
		 */
		const admitToChild = async (
			draft: Input | Write,
			steps: { readonly before?: (tx: Tx) => Promise<void>; readonly after?: (tx: Tx) => Promise<void> },
			context: Context,
		) => {
			const { before, after } = steps;

			if (before !== undefined) {
				await place.store.commit(async (tx) => {
					await before(tx);

					return undefined;
				}, context);
			}

			await conversation.submit(draft, context);

			const closed = await commitFor(
				place,
				async (tx) => {
					if ((await tx.doc(ChildDoc, id)).closed) return true;
					await after?.(tx);

					return false;
				},
				context,
			);

			if (closed) {
				await conversation.abort(context, { background: true });
				throw new Error(`The child ${id} is closed`);
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

				await refuseClosed(tx);

				// A request that is still pending keeps its ask.
				if (record === undefined) await answers.prepare(tx, id, attempt, schema);

				return undefined;
			}, context);

			if (saved !== undefined) return saved;
			const request = { ...input, requestId: attempt };
			await admitToChild(request, { after: (tx) => recordAdmission(tx, request.requestId) }, context);

			return withRespond(await settled(context, attempt), attempt, schema, context);
		}

		return {
			id,
			lineage: childLineage,
			conversation,
			async send(input, context, options) {
				const before = async (tx: Tx) => {
					if ((await tx.submissionByRequest(id, input.requestId)) !== undefined) return;
					await refuseClosed(tx);
					await answers.prepare(tx, id, input.requestId);
				};

				const after = async (tx: Tx) => {
					await recordAdmission(tx, input.requestId);
					await options?.admitted?.(tx);
				};

				await admitToChild(input, { before, after }, context);
			},
			async write(write, context) {
				const before = async (tx: Tx) => {
					if ((await tx.submissionByRequest(id, write.requestId)) === undefined) await refuseClosed(tx);
				};

				await admitToChild(write, { before }, context);
			},
			ask,
			settled,
			lastRequest: async (context) => (await lastRequest(context)) ?? null,
			async state(context) {
				if ((await place.store.snapshot(ChildDoc, id, context))?.closed === true) return "closed";

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
				// One commit reads the subtree and marks it, so a child that `open` adds under it is either marked or refused.
				const ids = await commitFor(
					place,
					async (tx) => {
						const members = [id];

						// The loop also visits the IDs that it appends.
						for (const member of members) members.push(...(await tx.doc(ChildDoc, member)).children);
						const closing = members.slice(options?.below === true ? 1 : 0);

						for (const member of closing) (await tx.doc(ChildDoc, member)).closed = true;

						return closing;
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

		if (id === undefined || id === 0) return undefined;
		const doc = await childDoc(place.store, id, context);
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
			const depth = (parent?.depth ?? 0) + 1;
			const limit = parent?.limit ?? spec.limit ?? DEFAULT_DEPTH_LIMIT;

			if (depth > limit) throw new Error("Nested subagents are disabled");
			const root = parent?.root ?? spec.root ?? spec.parent;

			if (root === undefined) throw new Error("A child needs a root or a parent");

			const create = async (tx: Tx, ownerTask: TaskId) => {
				const known = await tx.doc(Keys, key, null);

				if (known.conversation !== 0) return undefined;

				if (parent !== undefined && parentId !== undefined && (await tx.doc(ChildDoc, parentId)).closed) {
					throw new Error(`The child ${parentId} is closed`);
				}

				const child = await tx.createConversation({ ownership: { kind: "task", taskId: ownerTask } });
				let change: AgentChange = { model, thinkingLevel };

				if (cwd !== undefined) change = { ...change, cwd };

				if (tools !== undefined) change = { ...change, tools };

				if (spec.instructions !== undefined) change = { ...change, instructions: spec.instructions };
				await durable.configure(tx, child.id, change);
				// The child keeps the extensions of the owner's agent and selects the answer extension too.
				const agent = await tx.doc(durable.AgentDoc, child.id);
				const answerName = answers.extension.name;
				const selection = agent.extensions;

				if (Array.isArray(selection)) {
					if (!selection.includes(answerName)) selection.push(answerName);
				} else if (!selection?.add?.includes(answerName)) {
					agent.extensions = { ...selection, add: [...(selection?.add ?? []), answerName] };
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

				// A parent that the library opened lists the child, so closing the parent closes it too.
				if (parent !== undefined && parentId !== undefined) (await tx.doc(ChildDoc, parentId)).children.push(child.id);
				known.conversation = child.id;
				await setup?.(tx, child.id);

				return undefined;
			};

			if (owner.kind === "detached") {
				await owner.root.commit(async (tx) => {
					if ((await tx.doc(Keys, key, null)).conversation !== 0) return undefined;
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

/** The model and the thinking level of a child. */
export type ResolvedModel = { model: ModelRef; thinkingLevel: ModelThinkingLevel };

/**
 * The model and thinking level of `request`; a field left out comes from `fallback`. An explicit `thinking` that the
 * model does not have is refused. Without it, the level is `fallbackThinking`, else the fallback's, clamped to the
 * nearest level that the model has.
 */
export function resolveModel(
	models: Models,
	fallback: Pick<Agent, "model" | "thinkingLevel"> | undefined,
	request: {
		readonly provider?: string | undefined;
		readonly model?: string | undefined;
		readonly thinking?: string | undefined;
		readonly fallbackThinking?: string | undefined;
	},
): ResolvedModel {
	const provider = request.provider ?? fallback?.model?.provider;
	const modelId = request.model ?? fallback?.model?.modelId;

	if (provider === undefined || modelId === undefined) {
		throw new Error("No model: neither the spec nor the owner's agent names one");
	}

	const model = models.getModel(provider, modelId);

	if (model === undefined) throw new Error(`Unknown model: ${provider}/${modelId}`);
	const levels = getSupportedThinkingLevels(model);

	if (request.thinking !== undefined) {
		const thinkingLevel = levels.find((level) => level === request.thinking);

		if (thinkingLevel === undefined)
			throw new Error(`${provider}/${modelId} has no thinking level ${request.thinking}`);

		return { model: { provider, modelId }, thinkingLevel };
	}

	const inherited = request.fallbackThinking ?? fallback?.thinkingLevel ?? "off";
	const known = MODEL_THINKING_LEVELS.find((level) => level === inherited);

	// `clampThinkingLevel` gives the model's first level for a name that it does not know.
	return {
		model: { provider, modelId },
		thinkingLevel: known === undefined ? (levels[0] ?? "off") : clampThinkingLevel(model, known),
	};
}

/** The conversation ID that `value` spells, as callers write it; nothing for another caller, such as a Pi session. */
function conversationIdOf(value: string): ConversationId | undefined {
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return undefined;

	// SAFETY: a conversation ID is a positive safe integer, and the callers look up the conversation of this one.
	return Number(value) as ConversationId;
}

/** Adds every counter of `state` to `sum`. A counter that one side leaves out counts as 0. */
function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const) {
		const totals = sum[bucket];

		for (const [key, usage] of Object.entries(state[bucket])) {
			const total = Object.hasOwn(totals, key) ? totals[key] : undefined;

			if (total === undefined) {
				// Define rather than assign: assigning a tool named `__proto__` would set the prototype.
				Object.defineProperty(totals, key, { value: structuredClone(usage), enumerable: true, writable: true });
				continue;
			}

			total.input += usage.input;
			total.output += usage.output;
			total.cacheRead += usage.cacheRead;
			total.cacheWrite += usage.cacheWrite;
			total.totalTokens += usage.totalTokens;

			if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;

			if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
			total.cost.input += usage.cost.input;
			total.cost.output += usage.cost.output;
			total.cost.cacheRead += usage.cost.cacheRead;
			total.cost.cacheWrite += usage.cost.cacheWrite;
			total.cost.total += usage.cost.total;
		}
	}
}
