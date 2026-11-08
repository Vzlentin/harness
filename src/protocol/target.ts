import { type Static, type TProperties, Type } from "typebox";

/**
 * The handle of the project agent, the host's root conversation, in `watch`, `input`, `note`, `abort` and `configure`. It
 * is not hex, so no child has it.
 */
export const AGENT_HANDLE = "agent";

/**
 * The target of `watch`, `input`, `note`, `abort` and `configure`: a child by handle, the project agent, or a
 * conversation that the children library opened, such as a child of a task.
 */
export type Target =
	| { readonly kind: "child"; readonly handle: string }
	| { readonly kind: "agent" }
	| { readonly kind: "conversation"; readonly id: string };

/**
 * The two objects with `fields` and a target on the wire: one with `handle`, one with `conversation`. Each refuses the
 * other key, because an object schema accepts extra keys. A caller that needs one schema wraps them in a union.
 */
export function withTarget<F extends TProperties>(fields: F) {
	const handle = Type.Object({ ...fields, handle: Type.String(), conversation: Type.Optional(Type.Never()) });
	const conversation = Type.Object({ ...fields, conversation: Type.String(), handle: Type.Optional(Type.Never()) });
	const branches: [typeof handle, typeof conversation] = [handle, conversation];

	return branches;
}

/** A target on the wire: a handle, which can be `AGENT_HANDLE`, or a conversation ID. */
export const TargetRef = Type.Union(withTarget({}));

export type TargetRef = Static<typeof TargetRef>;

/** The target of a wire reference. */
export function parseTarget(ref: TargetRef): Target {
	if (ref.conversation !== undefined) return { kind: "conversation", id: ref.conversation };

	return ref.handle === AGENT_HANDLE ? { kind: "agent" } : { kind: "child", handle: ref.handle };
}

/** The wire reference of `target`. A child and the project agent have a handle. */
export function targetRef(target: Exclude<Target, { kind: "conversation" }>): { handle: string };
export function targetRef(target: Target): TargetRef;
export function targetRef(target: Target): TargetRef {
	switch (target.kind) {
		case "child":
			return { handle: target.handle };
		case "agent":
			return { handle: AGENT_HANDLE };
		case "conversation":
			return { conversation: target.id };
	}
}
