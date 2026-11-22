/**
 * The todo `Save to the vault` of an answered ask: the answer adds it to the list of the asker when the host has a
 * vault at that answer, and the note of the ask closes it. The todo names its ask in its field `ask`, and each ask has
 * at most one todo, in the list that its link names.
 */
import { statSync } from "node:fs";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { Ask } from "../protocol/asks.ts";
import type { Todo } from "../protocol/todo.ts";
import { knownSession } from "./sessions.ts";
import { library } from "./targets.ts";
import { addListTodo, draftOf, linkOwner, type TodoOwner } from "./todo-lists.ts";
import { isFinished } from "./todo.ts";

/**
 * Adds the todo `Save to the vault: <first line of the title>` for each answered ask of `asks` to the list of its asker
 * in `tx`, where `root` is the project agent. It reads the vault once for all of `asks`, and adds nothing when the host
 * has no vault. With a vault, it adds nothing for an ask that has a note, an asker with no list, or an ask that already
 * has its todo, in any state. It gives the todos that it added.
 */
export async function addSaveTodos(tx: Tx, root: ConversationId, asks: readonly Ask[]): Promise<Todo[]> {
	const added: Todo[] = [];

	if (!hasVault()) return added;

	for (const ask of asks) {
		if (ask.note !== undefined) continue;

		if ((await linkOwner(tx, ask.id)) !== undefined) continue;
		const owner = await askerList(tx, root, ask.asker);

		if (owner === undefined) continue;
		added.push(await addListTodo(tx, owner, `Save to the vault: ${ask.title.split(/\r?\n/)[0]}`, ask.id));
	}

	return added;
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
 * Whether the host has a vault: `VAULT` of its environment is set and names a folder that exists. A path that `stat`
 * cannot read, such as a symlink loop, is no vault, so it does not fail the answer.
 */
function hasVault(): boolean {
	const vault = process.env.VAULT;

	if (vault === undefined || vault === "") return false;

	try {
		return statSync(vault).isDirectory();
	} catch {
		return false;
	}
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
