import { type Static, Type } from "typebox";
import { CHILD_STATES, type ChildState } from "./requests.ts";
import { Todo } from "./todo.ts";

/** The states of a run node: the status of its task, as the tree gives it. */
export const RUN_STATES = ["pending", "running", "completed", "failed", "aborted"] as const;

export type RunState = (typeof RUN_STATES)[number];

/** The fields of every node of the tree. */
const NODE_FIELDS = {
	/** `agent`, the handle of a child, `conversation:<id>`, or `task:<key>` for a started task and `task:<id>` below it. */
	id: Type.String(),
	/** The ID of the node above. A root has none. */
	parent: Type.Optional(Type.String()),
	name: Type.String(),
	/** The list of todos of the node, in ID order. */
	todos: Type.Array(Todo),
};

/**
 * One node of the tree of a project: an agent (the project agent, a child, or a conversation of the children library)
 * with the state of a child, or a run (a started task, or a child task under it) with the state of its task.
 */
export const TreeNode = Type.Union([
	Type.Object({ ...NODE_FIELDS, kind: Type.Literal("agent"), state: Type.Enum(CHILD_STATES) }),
	Type.Object({ ...NODE_FIELDS, kind: Type.Literal("run"), state: Type.Enum(RUN_STATES) }),
]);

export type TreeNode = Static<typeof TreeNode>;

/** The reply of `tree` and `watch-tree`: the nodes, each parent before its children. */
export const TreeReply = Type.Object({ nodes: Type.Array(TreeNode) });

export type TreeReply = Static<typeof TreeReply>;

/** An event of `watch-tree` after its reply: the nodes that are new or changed, or the IDs of the nodes that went. */
export const TreeEvent = Type.Union([
	Type.Object({ nodes: Type.Array(TreeNode) }),
	Type.Object({ removed: Type.Array(Type.String()) }),
]);

export type TreeEvent = Static<typeof TreeEvent>;

/** The mark of each state in the line of a node. */
export const NODE_MARKS = {
	busy: "◉",
	running: "◉",
	idle: "○",
	pending: "○",
	closed: "✓",
	completed: "✓",
	error: "✗",
	failed: "✗",
	aborted: "✗",
} as const satisfies Record<ChildState | RunState, string>;

/**
 * The line of each node of `nodes`, which come parents first: two spaces for each level, then
 * `<mark> <name>  <state>  <n> open`, where `n` counts the todos in the state `open`.
 */
export function treeLines(nodes: readonly TreeNode[]): string[] {
	const depths = new Map<string, number>();

	return nodes.map((node) => {
		const depth = node.parent === undefined ? 0 : (depths.get(node.parent) ?? -1) + 1;
		depths.set(node.id, depth);
		const open = node.todos.filter((todo) => todo.state === "open").length;

		return `${"  ".repeat(depth)}${NODE_MARKS[node.state]} ${node.name}  ${node.state}  ${open} open`;
	});
}
