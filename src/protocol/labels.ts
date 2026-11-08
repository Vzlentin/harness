import type { ChildInfo, Delivery } from "./requests.ts";
import { AGENT_HANDLE } from "./target.ts";

/** The text of the message that brings `delivery` to its caller. */
export function deliveryText(delivery: Delivery): string {
	return `subagent ${runDisplayName(delivery)} ${delivery.failed ? "failed" : "finished"}\n\n${delivery.text}`;
}

export function isValidRunName(value: string): boolean {
	return (
		value.length > 0 && value.length <= 64 && value.trim() === value && !Array.from(value).some(isControlCharacter)
	);
}

/** U+0000 to U+001F and U+007F. */
function isControlCharacter(character: string): boolean {
	const code = character.charCodeAt(0);

	return code <= 0x1f || code === 0x7f;
}

type Labeled = {
	readonly handle: string;
	readonly name?: string | undefined;
	readonly conversation?: string | undefined;
};

/** The label of a child: its name, or its handle when it has no name. */
export function childLabel(child: Labeled): string {
	return child.name ?? child.handle;
}

export function runDisplayName(metadata: { readonly handle: string; readonly name?: string | undefined }): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

/**
 * The title of a child in a client: `<name> (<handle>)`, or only the name for the project agent, which says what it is,
 * and for a conversation, whose name is its key.
 */
export function childTitle(child: Labeled): string {
	return child.handle === AGENT_HANDLE || child.conversation !== undefined ? childLabel(child) : runDisplayName(child);
}

/** The line of one child in a list, with the marker of an RLM child at its end. */
export function childLine(child: ChildInfo): string {
	const line = `${runDisplayName(child)}  ${child.state.padEnd(8)}  ${child.provider}/${child.model}  ${child.thinking}`;

	return child.kind === undefined ? line : `${line}  ${child.kind}`;
}
