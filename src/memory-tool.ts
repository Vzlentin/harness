/**
 * The `memory` tool: its description and its schema, which the host and the Pi extension register.
 */
import type * as TypeBox from "typebox";
import type { Static, TSchema } from "typebox";

/** The most bytes of one memory, which is also the hard top of OptMem. */
export const NOTE_LIMIT = 280;

export const MEMORY_TOOL_DESCRIPTION = `Keep your memory: what you learn and what happens, across sessions. Your memory is in the \`memory\` section of the system prompt, oldest first. A line \`#a-b\` there is the summary of the memories #a to #b.
- note: save \`text\`, one line of at most ${NOTE_LIMIT} bytes (an accented character costs 2), when you learn something new or something worth keeping happens: a task worth real effort, a fact or insight that the user teaches you, anything you learn about the user's life (even indirectly), an event of lasting effect. Note a decision when it is settled, not each round of an open discussion. Do not note what the memory already has. When a subagent or a workflows run gives you a result, note what you keep of it.
- recall: the memories that match the regex \`pattern\`, word for word, case-insensitive.
- zoom: open the node \`block\` of the memory, such as \`16-31\`, into its two halves, down to the raw memories.`;

/** The schemas of the `memory` tool, built with the caller's TypeBox. */
export function memoryToolSchemas(typebox: Pick<typeof TypeBox, "Type">) {
	const { Type: T } = typebox;

	return {
		parameters: T.Object({
			action: T.Union([T.Literal("note"), T.Literal("recall"), T.Literal("zoom")], { description: "What to do" }),
			text: T.Optional(T.String({ description: `note: the memory, one line of at most ${NOTE_LIMIT} bytes` })),
			pattern: T.Optional(T.String({ description: "recall: the regex" })),
			block: T.Optional(T.String({ description: "zoom: the node, such as 16-31" })),
		}),
	};
}

type MemorySchemas = ReturnType<typeof memoryToolSchemas>;

export type MemoryToolArgs = Static<MemorySchemas["parameters"]>;

/** The `memory` tool, as the host and the Pi extension register it. */
export type MemoryTool<P extends TSchema> = {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: P;
};

/** The `memory` tool, given to `adapt`. */
export function memoryTool<R>(
	typebox: Pick<typeof TypeBox, "Type">,
	adapt: (tool: MemoryTool<MemorySchemas["parameters"]>) => R,
): R {
	const { parameters } = memoryToolSchemas(typebox);

	return adapt({ name: "memory", label: "Memory", description: MEMORY_TOOL_DESCRIPTION, parameters });
}
