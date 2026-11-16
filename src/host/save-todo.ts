/**
 * The todo `Save to the vault` of an answered ask: the answer adds it to the list of the asker, and the note of the ask
 * closes it. The todo names its ask in its field `ask`, and each ask has at most one todo, in the list that its link
 * names.
 */
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { type Ask, isReadBack } from "../protocol/project.ts";
import { knownSession } from "./sessions.ts";
import { library } from "./targets.ts";
import { addListTodo, draftOf, linkOwner, type TodoOwner } from "./todo-lists.ts";
import { isFinished } from "./todo.ts";

/**
 * Adds the todo `Save to the vault: <first line of the title>` for the answered ask `ask` to the list of its asker in
 * `tx`, where `root` is the project agent. It adds nothing for the read-back of a parley, an ask that has a note, an
 * asker with no list, or an ask that already has its todo, in any state.
 */
export async function addSaveTodo(tx: Tx, root: ConversationId, ask: Ask): Promise<void> {
	if (isReadBack(ask) || ask.note !== undefined) return;

	if ((await linkOwner(tx, ask.id)) !== undefined) return;
	const owner = await askerList(tx, root, ask.asker);

	if (owner === undefined) return;
	await addListTodo(tx, owner, `Save to the vault: ${ask.title.split(/\r?\n/)[0]}`, ask.id);
}

/**
 * Sets the todo of the ask `ask` in `tx` to `done`, unless it is done or dropped. It reads only the list that the link
 * of the ask names, so it creates no list, and it finds the todo also when the host no longer knows the asker.
 */
export async function closeSaveTodo(tx: Tx, ask: Ask): Promise<void> {
	const owner = await linkOwner(tx, ask.id);

	if (owner === undefined) return;
	const todo = (await draftOf(tx, owner)).todos.find((found) => found.ask === ask.id);

	if (todo !== undefined && !isFinished(todo.state)) todo.state = "done";
}

/**
 * The list of `asker` in `tx`: the list of the project agent `root` or of a conversation that the children library
 * opened, or the list of a Pi session of the host. Nothing for another asker, such as a session of a workflows run.
 */
async function askerList(tx: Tx, root: ConversationId, asker: string): Promise<TodoOwner | undefined> {
	if (asker === String(root)) return { kind: "conversation", id: root };
	const opened = await library.opened(tx, asker);

	if (opened !== undefined) return { kind: "conversation", id: opened };

	return (await knownSession(tx, asker)) ? { kind: "caller", caller: asker } : undefined;
}
