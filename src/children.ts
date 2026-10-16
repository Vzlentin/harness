/**
 * The children library: creates and drives child conversations on whatever pi-durable store its caller hands it. Its
 * caller passes its pi-durable module, so a process never holds two copies.
 */
import type { Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type * as Durable from "@earendil-works/pi-durable";
import type {
	Conversation,
	ConversationId,
	DocumentReader,
	EntryId,
	Extension,
	RegistrySnapshot,
	TaskId,
	ToolRegistration,
	Tx,
} from "@earendil-works/pi-durable";

/** The deepest child by default: a child of a child of a root. */
export const DEFAULT_DEPTH_LIMIT = 2;

/**
 * The store children live in: a Harness, or a running task's runtime. `commit` callbacks return nothing, as a task's
 * do, and read back through `tx` or `snapshot`.
 */
export type Store = {
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown>;
	readonly snapshot: DocumentReader["snapshot"];
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
};

/** Where children live: the store, the models they run on, and the tools that `Spec.tools` names. */
export type Place = {
	readonly store: Store;
	readonly models: Models;
	/** The tools that `Spec.tools` names resolve among, by name; the last of a name wins. */
	readonly registry: RegistrySnapshot;
};

/**
 * Who owns a child, which decides what aborts reach it: a running task, whose abort aborts the child, or an anchor task
 * of its own in `root`, the store's root conversation, so the child outlives every request.
 */
export type Owner =
	| { readonly kind: "task"; readonly taskId: TaskId }
	| { readonly kind: "detached"; readonly root: Conversation };

/** What a child runs with. JSON only, so a socket can carry it. */
export type Spec = {
	/** The root of the tree, for a child of a conversation outside this store: a Pi session, a caller name. */
	readonly root?: string;
	/** The conversation in this store that spawns the child. */
	readonly parent?: string;
	readonly provider: string;
	readonly model: string;
	readonly thinking?: string;
	readonly cwd?: string;
	/** The only tools the child gets, by name. */
	readonly tools?: readonly string[];
	readonly instructions?: string;
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
 * What a turn returns. `cut` keeps the text, which stopped before its end. `unanswered` has `why`: the settlement's
 * reason, such as `aborted`, with its `detail`, or `pending` when the child went idle with the request still queued.
 */
export type Answer =
	| { readonly status: "ok"; readonly text: string; readonly entry: EntryId }
	| {
			readonly status: "failed";
			readonly reason: "cut";
			readonly text: string;
			readonly entry: EntryId;
			readonly stopReason: string;
	  }
	| { readonly status: "failed"; readonly reason: "unanswered"; readonly why: string; readonly detail?: unknown };

/** Input to a child, at most once per request ID. */
export type Input = Parameters<Conversation["submit"]>[0] & { readonly type: "input"; readonly requestId: string };

/** One child, driven by its operations. */
export type Child = {
	readonly id: ConversationId;
	readonly lineage: Lineage;
	/** The child's conversation, for what the library does not cover: its agent, a watch, an abort of its turn. */
	readonly conversation: Conversation;
	/**
	 * Admits `input` and returns. A request ID admitted before is not admitted again. A new request ID becomes the last
	 * request before the submit, so a crash between the two still finds it.
	 */
	send(input: Input, context: Context): Promise<void>;
	/**
	 * Waits until the child is idle, then gives the answer to `request` (default: the last one). Aborting the wait
	 * through `context` stops only the wait.
	 */
	settled(context: Context, request?: string): Promise<Answer>;
	state(context: Context): Promise<ChildState>;
	/** Aborts the child, background work included, and marks it closed. */
	close(context: Context): Promise<void>;
};

export type Children = {
	/** The extension with the library's task; the caller installs it in its registry. */
	readonly extension: Extension;
	/**
	 * The child of `key`: created the first time `key` is seen, with its lineage, in one commit, and the same child after.
	 * `setup` runs in the creating commit. It refuses, before creating anything, an unknown model or tool and a parent at
	 * its depth limit. Keys are global in a store, so callers prefix them.
	 */
	open(
		place: Place,
		owner: Owner,
		key: string,
		spec: Spec,
		context: Context,
		setup?: (tx: Tx, id: ConversationId) => Promise<void>,
	): Promise<Child>;
	/** The child of a key or a conversation ID opened earlier, also after a restart. */
	find(
		place: Place,
		which: { readonly key: string } | { readonly id: string },
		context: Context,
	): Promise<Child | undefined>;
	/** Where the conversation `id` sits in its tree; nothing for a conversation that the library did not open. */
	lineage(store: Pick<Store, "snapshot">, id: string, context: Context): Promise<Lineage | undefined>;
};

type ChildDocState = {
	key: string;
	root: string;
	parent: string | null;
	depth: number;
	limit: number;
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
		initial: () => ({ key: "", root: "", parent: null, depth: 0, limit: 0, lastRequest: null, closed: false }),
	});
	/** The conversation of each key; 0 before it exists. */
	const Keys = durable.defineDocFamily<{ conversation: number }, null>({
		kind: "pi-subagent.key",
		version: 1,
		scope: "session",
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

	const lineageOf = (doc: Readonly<ChildDocState>): Lineage => ({
		key: doc.key,
		root: doc.root,
		...(doc.parent === null ? {} : { parent: doc.parent }),
		depth: doc.depth,
		limit: doc.limit,
	});

	async function lineage(store: Pick<Store, "snapshot">, id: string, context: Context) {
		const conversation = conversationIdOf(id);
		if (conversation === undefined) return undefined;
		const doc = await store.snapshot(ChildDoc, conversation, context);
		return doc === undefined || doc.key === "" ? undefined : lineageOf(doc);
	}

	async function childOf(place: Place, id: ConversationId, context: Context): Promise<Child | undefined> {
		const found = await lineage(place.store, String(id), context);
		const conversation = await place.store.conversation(id, context);
		if (found === undefined || conversation === undefined) return undefined;
		return makeChild(place, id, found, conversation);
	}

	/** Reads through a commit, which returns nothing on a task's runtime. */
	async function read<T>(place: Place, reader: (tx: Tx) => Promise<T>, context: Context): Promise<T> {
		let value: T | undefined;
		await place.store.commit(async (tx) => {
			value = await reader(tx);
			return undefined;
		}, context);
		return value as T;
	}

	function makeChild(place: Place, id: ConversationId, childLineage: Lineage, conversation: Conversation): Child {
		const lastRequest = async (context: Context) => (await place.store.snapshot(ChildDoc, id, context))?.lastRequest;
		const settlement = (request: string, context: Context) =>
			read(place, (tx) => tx.submissionByRequest(id, request), context);
		return {
			id,
			lineage: childLineage,
			conversation,
			async send(input, context) {
				await place.store.commit(async (tx) => {
					if ((await tx.submissionByRequest(id, input.requestId)) !== undefined) return undefined;
					(await tx.doc(ChildDoc, id)).lastRequest = input.requestId;
					return undefined;
				}, context);
				await conversation.submit(input, context);
			},
			async settled(context, request) {
				await conversation.waitForIdle(context);
				const requestId = request ?? (await lastRequest(context));
				const settled = requestId == null ? undefined : await settlement(requestId, context);
				if (settled?.status === "unanswered") {
					return { status: "failed", reason: "unanswered", why: settled.reason, detail: settled.detail };
				}
				if (settled?.status !== "done" || settled.answer === undefined) {
					return { status: "failed", reason: "unanswered", why: "pending" };
				}
				const entry = settled.answer;
				const message = (await read(place, (tx) => tx.entry(durable.AssistantEntry, entry), context))?.model?.[0];
				if (message?.role !== "assistant") return { status: "failed", reason: "unanswered", why: "missing" };
				const text = message.content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n")
					.trim();
				if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
					return { status: "failed", reason: "cut", text, entry, stopReason: message.stopReason };
				}
				return { status: "ok", text, entry };
			},
			async state(context) {
				if ((await place.store.snapshot(ChildDoc, id, context))?.closed === true) return "closed";
				const live = await place.store.snapshot(durable.LiveDoc, id, context);
				if (live?.run !== undefined) return "busy";
				const requestId = await lastRequest(context);
				const settled = requestId == null ? undefined : await settlement(requestId, context);
				// An aborted turn leaves the child idle.
				return settled?.status === "unanswered" && settled.reason !== "aborted" ? "error" : "idle";
			},
			async close(context) {
				await conversation.abort(context, { background: true });
				await place.store.commit(async (tx) => {
					(await tx.doc(ChildDoc, id)).closed = true;
					return undefined;
				}, context);
			},
		};
	}

	const find: Children["find"] = async (place, which, context) => {
		const id =
			"key" in which
				? (await place.store.snapshot(Keys, which.key, context))?.conversation
				: conversationIdOf(which.id);
		return id === undefined || id === 0 ? undefined : childOf(place, id as ConversationId, context);
	};

	return {
		extension: durable.defineExtension({ name: "pi-subagent-children", tasks: [Anchor] }),
		lineage,
		find,
		async open(place, owner, key, spec, context, setup) {
			const existing = await find(place, { key }, context);
			if (existing !== undefined) return existing;
			if (place.models.getModel(spec.provider, spec.model) === undefined) {
				throw new Error(`Unknown model: ${spec.provider}/${spec.model}`);
			}
			let tools: ToolRegistration[] | undefined;
			if (spec.tools !== undefined) {
				const installed = place.registry.tools();
				tools = spec.tools.map((name) => {
					const found = installed.findLast(({ tool }) => tool.name === name);
					if (found === undefined) throw new Error(`Unknown tool: ${name}`);
					return found.tool;
				});
			}
			const parent = spec.parent === undefined ? undefined : await lineage(place.store, spec.parent, context);
			const depth = (parent?.depth ?? 0) + 1;
			const limit = parent?.limit ?? DEFAULT_DEPTH_LIMIT;
			if (depth > limit) throw new Error("Nested subagents are disabled");
			const root = parent?.root ?? spec.root ?? spec.parent;
			if (root === undefined) throw new Error("A child needs a root or a parent");

			const create = async (tx: Tx, ownerTask: TaskId) => {
				const known = await tx.doc(Keys, key, null);
				if (known.conversation !== 0) return undefined;
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: ownerTask } });
				await durable.configure(tx, child.id, {
					model: { provider: spec.provider, modelId: spec.model },
					...(spec.thinking === undefined ? {} : { thinkingLevel: spec.thinking as ModelThinkingLevel }),
					...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
					...(tools === undefined ? {} : { tools }),
					...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
				});
				Object.assign(await tx.doc(ChildDoc, child.id), {
					key,
					root,
					parent: spec.parent ?? null,
					depth,
					limit,
					lastRequest: null,
					closed: false,
				});
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
			const opened = await find(place, { key }, context);
			if (opened === undefined) throw new Error(`The child of ${key} is missing`);
			return opened;
		},
	};
}

/** The conversation ID that `value` spells, as callers write it; nothing for another caller, such as a Pi session. */
function conversationIdOf(value: string): ConversationId | undefined {
	return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
		? (Number(value) as ConversationId)
		: undefined;
}
