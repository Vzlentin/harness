import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	createRegistry,
	type DocumentAddress,
	Harness,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ChildRecords } from "../src/host/records.ts";
import { AgentState } from "../src/host/targets.ts";
import { addListTodo, CallerTodos, ConversationTodos, linkOwner, TaskTodos } from "../src/host/todo-lists.ts";
import { queueAnswers, readUserAnswers, USER_ANSWERS_KIND } from "../src/host/user-answers.ts";
import { Persons } from "../src/projects/project-docs.ts";
import { addPerson } from "../src/projects/project.ts";
import { PERSONS_KIND } from "../src/protocol/project.ts";
import { TASK_TODO_LIST_KIND, TODO_LIST_KIND } from "../src/protocol/todo.ts";
import { models, root, setUp, tearDown } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

/** The number of rounds of the test. The first round creates each document. */
const ROUNDS = 66;

beforeAll(setUp);

afterAll(tearDown);

/** The address of each document that a round writes, by a name for the test. */
function addresses(conversationId: ConversationId) {
	const session = { kind: "session" } as const;

	return {
		persons: { kind: PERSONS_KIND, scope: session },
		conversationTodos: { kind: TODO_LIST_KIND, scope: { kind: "conversation", conversationId } },
		links: { kind: "harness.save-todos", scope: session },
		callerTodos: { kind: CallerTodos.definition.kind, scope: session, key: "cli" },
		taskTodos: { kind: TASK_TODO_LIST_KIND, scope: session, key: "1" },
		childRecords: { kind: ChildRecords.definition.kind, scope: session },
		agentState: { kind: AgentState.definition.kind, scope: { kind: "conversation", conversationId } },
		userAnswers: { kind: USER_ANSWERS_KIND, scope: session },
	} satisfies Record<string, DocumentAddress>;
}

/** Writes each document of `addresses` once, in one commit. */
async function writeRound(harness: Harness, conversationId: ConversationId, round: number): Promise<void> {
	await harness.commit(async (tx) => {
		await addPerson(tx, { name: `person ${round}` });
		await addListTodo(tx, { kind: "conversation", id: conversationId }, `todo ${round}`, round);
		await addListTodo(tx, { kind: "caller", caller: "cli" }, `todo ${round}`);
		(await tx.doc(TaskTodos, "1", null)).todos.push({ id: round, text: `todo ${round}`, state: "open" });
		(await tx.doc(ChildRecords)).requests[`r${round}`] = "h";
		(await tx.doc(AgentState, conversationId)).lastRequest = `r${round}`;
		await queueAnswers(tx, [{ asker: "cli", delivery: { source: "ask", ask: round, text: "x" } }]);
	}, context);
}

/** The deltas after the newest base of each document of `found`, by name. */
async function tails(storage: Storage, found: Record<string, DocumentAddress>): Promise<Record<string, number>> {
	const result: Record<string, number> = {};

	for (const [name, address] of Object.entries(found)) {
		const record = await storage.findDocument(address, "current", context);
		const stored = record === undefined ? undefined : await storage.document(record.id, "current", context);

		if (stored !== undefined) result[name] = stored.deltasSinceBase;
	}

	return result;
}

/** `value` for each name of `found`. */
function each(found: Record<string, DocumentAddress>, value: number): Record<string, number> {
	return Object.fromEntries(Object.keys(found).map((name) => [name, value]));
}

/** The number of items of each list document in `tx`, and the number of asks from 1 to `ROUNDS` that have a link. */
async function lengths(tx: Tx, conversationId: ConversationId): Promise<Record<string, number>> {
	let links = 0;

	for (let ask = 1; ask <= ROUNDS; ask++) if ((await linkOwner(tx, ask)) !== undefined) links += 1;

	return {
		persons: (await tx.doc(Persons)).persons.length,
		conversationTodos: (await tx.doc(ConversationTodos, conversationId)).todos.length,
		links,
		callerTodos: (await tx.doc(CallerTodos, "cli", null)).todos.length,
		taskTodos: (await tx.doc(TaskTodos, "1", null)).todos.length,
		childRecords: Object.keys((await tx.doc(ChildRecords)).requests).length,
	};
}

/** A harness over the store file `path`, with its storage. */
async function openStore(path: string): Promise<{ harness: Harness; storage: Storage }> {
	const storage = await openNodeSqliteStorage(path);

	return { harness: await Harness.open(storage, { models, registry: createRegistry() }, context), storage };
}

describe("the checkpoint rule of the host's documents", () => {
	it("stores a change as a base when 64 deltas follow the newest base, and keeps each change", async () => {
		const path = join(await mkdtemp(join(root, "checkpoint-")), "store.sqlite");
		const { harness, storage } = await openStore(path);
		const conversationId = (await harness.root(context)).id;
		const found = addresses(conversationId);

		try {
			for (let round = 1; round < ROUNDS; round++) await writeRound(harness, conversationId, round);
			expect(await tails(storage, found)).toEqual(each(found, 64));
			await writeRound(harness, conversationId, ROUNDS);
			expect(await tails(storage, found)).toEqual(each(found, 0));
		} finally {
			await harness.close(context);
		}

		const reopened = (await openStore(path)).harness;

		try {
			expect(await reopened.commit((tx) => lengths(tx, conversationId), context)).toEqual({
				persons: ROUNDS,
				conversationTodos: ROUNDS,
				links: ROUNDS,
				callerTodos: ROUNDS,
				taskTodos: ROUNDS,
				childRecords: ROUNDS,
			});
			expect(await reopened.commit(async (tx) => (await tx.doc(AgentState, conversationId)).lastRequest, context)).toBe(
				`r${ROUNDS}`,
			);
			expect((await readUserAnswers(reopened, context)).map((answer) => answer.id)).toEqual(
				Array.from({ length: ROUNDS }, (_, index) => index + 1),
			);
		} finally {
			await reopened.close(context);
		}
	});
});
