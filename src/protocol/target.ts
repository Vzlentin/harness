/**
 * The handle of the project agent, the host's root conversation, in `watch`, `input`, `note`, `abort` and `configure`. It
 * is not hex, so no child has it.
 */
export const AGENT_HANDLE = "agent";

/**
 * The target of `watch`, `input` and `abort`: a handle, or the ID of a conversation that the children library opened,
 * such as a child of a task.
 */
export type Target =
	| { readonly handle: string; readonly conversation?: never }
	| { readonly conversation: string; readonly handle?: never };
