/**
 * The targets of the host's requests: the children by handle, the project agent, and the conversations of the children
 * library by ID, with the `Children` records of the host and the commits of their read marks.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { type Conversation, type ConversationId, defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { type Child, createChildren, type Input, type Owner, type Place, type Write } from "./children.ts";
import { AGENT_HANDLE, type ChildInfo, type ChildState, type Target } from "./protocol.ts";
import { isHeld } from "./unread.ts";

const context = BACKGROUND_CONTEXT;

/** What the targets use of the host. */
export type TargetHost = {
	readonly harness: Harness;
	/** The host's store, models and tools, for the children library. */
	readonly place: Place;
	readonly owner: Owner;
	readonly project: string;
	/** The project agent: the root conversation, with a model and the project directory from its first use. */
	readonly agent: () => Promise<Conversation>;
};

export type ChildRecord = {
	name?: string;
	/** `PI_SESSION_ID` of the spawner: a Pi session, the conversation ID of another child, or `cli`. */
	caller: string;
	createdAt: string;
	conversationId: ConversationId;
	/** The request IDs of the spawn and of each `send` of the caller, in order. */
	sent?: string[];
	/** How many requests of `sent` a `wait` or a push gave the answer of. */
	read?: number;
	/** The request whose answer the last push gave as the last answer, so a `wait` for it gives no new answer. */
	pushed?: string;
	/** The request IDs of `sent` with `notify: false`, whose answers are not pushed and do not hold the caller. */
	quiet?: string[];
};

export type ChildrenState = { children: Record<string, ChildRecord>; requests: Record<string, string> };

/**
 * The children by handle, and the handle of each spawn request ID. Version 2 leaves each child's last request to the
 * children library; a store with version 1 has children that the library does not know.
 */
export const Children = defineDoc<ChildrenState>({
	kind: "subagent.children",
	version: 2,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ children: {}, requests: {} }),
});

/** The request ID of the project agent's newest input, which its `error` state comes from. */
const AgentState = defineDoc<{ lastRequest: string | null }>({
	kind: "harness.agent",
	version: 1,
	scope: "conversation",
	history: "latest",
	checkpointWhen: () => false,
	fork: "initial",
	initial: () => ({ lastRequest: null }),
});

/** The children library, on this process's pi-durable. */
export const library = createChildren(durable);

/**
 * The conversation of `ref`: a child or the project agent by handle, or a conversation of the children library by ID,
 * with its info, its input, and the record of a child.
 */
export async function target(handler: TargetHost, ref: Target) {
	if (ref.conversation !== undefined) return conversationTarget(handler, ref.conversation);
	const { handle } = ref;

	if (handle !== AGENT_HANDLE) return childTarget(handler, handle, await childRecord(handler.harness, handle));
	const root = await handler.agent();
	const { place, project } = handler;

	const turn = library.turn(place, root.id, root, {
		read: async (tx) => (await tx.doc(AgentState, root.id)).lastRequest,
		write: async (tx, requestId) => {
			(await tx.doc(AgentState, root.id)).lastRequest = requestId;
		},
	});

	return {
		conversation: root,
		info: async (): Promise<ChildInfo> => ({
			...(await agentFields(root)),
			handle,
			name: `${project} agent`,
			state: await turn.state(context),
		}),
		send: (input: Input) => turn.send(input, context),
		write: async (write: Write) => {
			await root.submit(write, context);
		},
		record: undefined,
	};
}

export type Found = Awaited<ReturnType<typeof target>>;

/** The options of a child's `send`, which a target that is not a child does not take. */
export type SendOptions = Parameters<Child["send"]>[2];

/**
 * The target of the library conversation `id`, of any owner, such as a child of a task. It has no record, and it takes
 * input only while it works, and a note while it is open.
 */
async function conversationTarget(handler: TargetHost, id: string) {
	const child = await library.inspect(handler.place, id, context);

	if (child === undefined) throw new Error(`Unknown conversation: ${id}`);
	const { conversation, lineage } = child;

	const info = async (): Promise<ChildInfo> => ({
		handle: id,
		conversation: id,
		name: lineage.key,
		state: await child.state(context),
		...(await agentFields(conversation)),
	});

	return {
		conversation,
		info,
		send: async (input: Input) => {
			if ((await child.state(context)) !== "busy") throw new Error(`${lineage.key} takes input only while it works`);
			// Small race: a turn that ends between the check and the submit starts a new turn; needs busy-only admission in
			// pi-durable.
			await conversation.submit({ ...input, whenBusy: "steer" }, context);
		},
		write: async (write: Write) => {
			if ((await child.state(context)) === "closed") throw new Error(`${lineage.key} takes input only while it works`);
			await conversation.submit(write, context);
		},
		record: undefined,
	};
}

/** The target of the child `handle`, whose record is `record`. */
export async function childTarget(handler: TargetHost, handle: string, record: ChildRecord) {
	const child = await childOf(handler, record);

	return {
		conversation: child.conversation,
		info: () => childInfo(handler, handle, record),
		send: (input: Input, options?: SendOptions) => child.send(input, context, options),
		write: (write: Write) => child.write(write, context),
		record,
	};
}

export async function childRecord(harness: Harness, handle: string): Promise<ChildRecord> {
	const state = await harness.snapshot(Children, context);
	const record = recordOf(state, handle);

	if (record === undefined) throw new Error(`Unknown subagent: ${handle}`);

	return record;
}

/** The record of `handle`, which must belong to `caller`. */
export async function ownRecord(harness: Harness, handle: string, caller: string): Promise<ChildRecord> {
	const record = await childRecord(harness, handle);

	if (record.caller !== caller) throw new Error(`Subagent ${handle} belongs to another session`);

	return record;
}

export async function childOf(handler: Pick<TargetHost, "place" | "owner">, record: ChildRecord): Promise<Child> {
	const child = await library.find(handler.place, handler.owner, { id: String(record.conversationId) }, context);

	if (child === undefined) throw new Error(`Missing conversation ${record.conversationId}`);

	return child;
}

/** The info of `handle`. A caller that already has the record gives it as `record`. */
export async function childInfo(
	handler: Pick<TargetHost, "harness" | "place" | "owner">,
	handle: string,
	record?: ChildRecord,
): Promise<ChildInfo> {
	record ??= await childRecord(handler.harness, handle);
	const child = await childOf(handler, record);
	const childState = await child.state(context);
	const held = isHeld(await handler.harness.snapshot(Children, context), record.conversationId);
	// A closed child that still holds its caller is closed: it never runs again.
	const state: ChildState = childState !== "closed" && held ? "busy" : childState;

	const fields = await agentFields(child.conversation);

	return record.name === undefined ? { handle, state, ...fields } : { handle, name: record.name, state, ...fields };
}

/** The model, thinking level and directory of the agent of `conversation`, for its info. */
async function agentFields(
	conversation: Conversation,
): Promise<Pick<ChildInfo, "provider" | "model" | "thinking" | "cwd">> {
	const agent = await conversation.agent(context);

	return {
		provider: agent.model?.provider ?? "",
		model: agent.model?.modelId ?? "",
		thinking: agent.thinkingLevel,
		// `spawnChild` refuses a spawn without `cwd`; the fallback only satisfies pi-durable's optional type.
		cwd: agent.cwd ?? "",
	};
}

/**
 * Adds `requestId` to the requests of `handle` that a `wait` gives the answers of, in `tx`, the commit that makes it the
 * child's last request. Without `notify`, its answer is not pushed. A repeated request is not added. It is the only
 * writer of `sent` and `quiet`.
 */
export async function addSent(
	tx: Tx,
	handle: string,
	requestId: string,
	options: { readonly notify: boolean },
): Promise<void> {
	const record = (await tx.doc(Children)).children[handle];
	const sent = record?.sent ?? [];

	if (record === undefined || sent.includes(requestId)) return;
	record.sent = [...sent, requestId];

	if (!options.notify) record.quiet = [...(record.quiet ?? []), requestId];
}

/**
 * Marks the requests of `handle` up to `read` as read; `read` never passes the length of `sent`. After a push, `pushed`
 * is the request whose answer the push gave last, so that a `wait` for it gives no new answer. It is kept only for a
 * request of `sent` or the input of a push.
 */
export async function markRead(harness: Harness, handle: string, read: number, pushed?: string): Promise<void> {
	await harness.commit(async (tx) => {
		const record = (await tx.doc(Children)).children[handle];

		if (record === undefined) return;
		const sent = record.sent ?? [];
		record.read = Math.min(Math.max(record.read ?? 0, read), sent.length);

		if (pushed !== undefined && (sent.includes(pushed) || isPushRequest(pushed))) record.pushed = pushed;
	}, context);
}

const PUSH_PREFIX = "push:";

/** The request ID of the push input that gives the answers of `handle` up to `read`. */
export function pushRequest(handle: string, read: number): string {
	return `${PUSH_PREFIX}${handle}:${read}`;
}

/** Whether `requestId` is the input of a push, which a conversation gets from its children. */
export function isPushRequest(requestId: string): boolean {
	return requestId.startsWith(PUSH_PREFIX);
}

/** Whether the conversation `id` runs a turn of its own, whatever its children do. */
export async function turnRunning(harness: Harness, id: ConversationId): Promise<boolean> {
	return (await harness.snapshot(durable.LiveDoc, id, context))?.run !== undefined;
}

/** The record of `handle` in the `Children` value `state`. */
export function recordOf(state: Readonly<ChildrenState> | null | undefined, handle: string): ChildRecord | undefined {
	return state != null && Object.hasOwn(state.children, handle) ? state.children[handle] : undefined;
}
