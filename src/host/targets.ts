/**
 * The targets of the host's requests: the children by handle, the project agent, and the conversations of the children
 * library by ID, with their info.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { type Conversation, type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import {
	type Child,
	createChildren,
	type Input,
	type Owner,
	type Place,
	type Turn,
	type Write,
} from "../children/library.ts";
import type { ChildInfo, ChildState } from "../protocol/requests.ts";
import { AGENT_HANDLE, type Target } from "../protocol/target.ts";
import { type ChildRecord, ChildRecords, type ChildrenState, childRecord, isHeld } from "./records.ts";

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

/** The request ID of the project agent's newest input, which its `error` state comes from. */
export const AgentState = defineDoc<{ lastRequest: string | null }>({
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
 * The conversation of `ref`: a child by handle, the project agent, or a conversation of the children library by ID,
 * with its info, its input, and the record of a child.
 */
export async function target(handler: TargetHost, ref: Target) {
	switch (ref.kind) {
		case "child":
			return childTarget(handler, ref.handle, await childRecord(handler.harness, ref.handle));
		case "conversation":
			return conversationTarget(handler, ref.id);
		case "agent":
			return agentTarget(handler);
	}
}

/** The conversation ID of `ref`, with no set-up of the project agent and no check of the caller of a child. */
export async function targetConversation(
	host: Pick<TargetHost, "harness" | "place"> & { readonly root: Conversation },
	ref: Target,
): Promise<ConversationId> {
	switch (ref.kind) {
		case "child":
			return (await childRecord(host.harness, ref.handle)).conversationId;
		case "conversation":
			return (await libraryConversation(host.place, ref.id)).conversation.id;
		case "agent":
			return host.root.id;
	}
}

/** The target of the project agent. It has no record. */
async function agentTarget(handler: TargetHost) {
	const root = await handler.agent();
	const { place, project } = handler;
	const turn = agentTurn(place, root);

	return {
		conversation: root,
		info: async (): Promise<ChildInfo> => ({
			...(await agentFields(root)),
			handle: AGENT_HANDLE,
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

/** The input and the state of the project agent, the root conversation `root`. The state needs no model. */
export function agentTurn(place: Place, root: Conversation): Turn {
	return library.turn(place, root.id, root, {
		read: async (tx) => (await tx.doc(AgentState, root.id)).lastRequest,
		write: async (tx, requestId) => {
			(await tx.doc(AgentState, root.id)).lastRequest = requestId;
		},
	});
}

export type Found = Awaited<ReturnType<typeof target>>;

/** The options of a child's `send`, which a target that is not a child does not take. */
export type SendOptions = Parameters<Child["send"]>[2];

/**
 * The target of the library conversation `id`, of any owner, such as a child of a task. It has no record, and it takes
 * input only while it works, and a note while it is open.
 */
async function conversationTarget(handler: TargetHost, id: string) {
	const child = await libraryConversation(handler.place, id);
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
			if ((await child.state(context)) === "closed") throw new Error(`The conversation ${id} is closed`);
			await conversation.submit(write, context);
		},
		record: undefined,
	};
}

/**
 * The conversation `id` that the children library opened, of any owner. A root, an unknown ID, or text that is not an ID
 * is refused.
 */
async function libraryConversation(place: Place, id: string) {
	const child = await library.inspect(place, id, context);

	if (child === undefined) throw new Error(`Unknown conversation: ${id}`);

	return child;
}

/**
 * The conversation of `caller` when it is the project agent or a conversation that the children library opened, such
 * as a child of this host; nothing for another caller, such as a Pi session or `cli`.
 */
export async function callerConversation(
	host: { readonly place: Place; readonly root: Conversation },
	caller: string,
): Promise<ConversationId | undefined> {
	if (caller === String(host.root.id)) return host.root.id;

	return (await library.inspect(host.place, caller, context))?.conversation.id;
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
	const records = await handler.harness.snapshot(ChildRecords, context);
	const state = heldState(childState, records, record.conversationId);

	const fields = await agentFields(child.conversation);

	let info: ChildInfo =
		record.name === undefined ? { handle, state, ...fields } : { handle, name: record.name, state, ...fields };

	if (record.kind !== undefined) info = { ...info, kind: record.kind };

	return info;
}

/**
 * The state of a child by handle, from `state`, the state of its conversation: `busy` also while one of its notify
 * children holds it, in `records`.
 */
export function heldState(
	state: ChildState,
	records: Readonly<ChildrenState> | undefined,
	conversationId: ConversationId,
): ChildState {
	// A closed child that still holds its caller is closed: it never runs again.
	return state !== "closed" && isHeld(records, conversationId) ? "busy" : state;
}

/** The model, thinking level and directory of the agent of `conversation`, for its info. */
async function agentFields(
	conversation: Conversation,
): Promise<Pick<ChildInfo, "provider" | "model" | "thinking" | "cwd">> {
	const agent = await conversation.agent(context);
	const { model, cwd } = agent;

	if (model === undefined) throw new Error(`The conversation ${conversation.id} has no model`);

	if (cwd === undefined) throw new Error(`The conversation ${conversation.id} has no working directory`);

	return { provider: model.provider, model: model.modelId, thinking: agent.thinkingLevel, cwd };
}

/** Whether the conversation `id` runs a turn of its own, whatever its children do. */
export async function turnRunning(harness: Harness, id: ConversationId): Promise<boolean> {
	return (await harness.snapshot(durable.LiveDoc, id, context))?.run !== undefined;
}
