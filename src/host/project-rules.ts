/**
 * The rules of the project: one document of the session. An agent adds and changes an open rule, the user changes a
 * rule in any status, and the source of a rule is a message of a thread. A delete of a message fails while a rule that
 * is not retired has it as its source, and removes it as the source of a retired rule.
 */
import type { Context } from "@earendil-works/chord/context";
import type { DocumentReader, Storage, Tx } from "@earendil-works/pi-durable";
import {
	type Rule,
	type RuleFilter,
	type RuleList,
	type RuleSet,
	type RuleUserChange,
	RULES_KIND,
} from "../protocol/project.ts";
import { entryId, known, knownAuthor, knownMessage, sessionDoc } from "./project-docs.ts";

/**
 * The rules, with `last`, the highest ID that a rule had, so that the ID of a deleted rule is never given again. A
 * store from before `last` has none, and its last rule has the highest ID.
 */
const Rules = sessionDoc<RuleList & { last?: number }>(RULES_KIND, () => ({ rules: [] }));

/**
 * Adds or changes a rule of an agent for the caller `by`, and gives it. A new rule is `open`, and `replaces` names the
 * rule that it replaces, which a decide of the new rule retires. Only an open rule changes. The rule gets the thread of
 * its source message.
 */
export async function setRule(tx: Tx, change: RuleSet, by: string): Promise<Rule> {
	if (change.id !== undefined && change.replaces !== undefined) {
		throw new Error("A change of a rule cannot replace a rule: set replaces on a new rule");
	}

	const { thread } = await knownMessage(tx, change.source);
	await knownAuthor(tx, change.saidBy);
	const list = await tx.doc(Rules);
	const at = Date.now();
	let rule: Rule;

	if (change.id === undefined) {
		rule = {
			id: nextRuleId(list),
			name: change.name,
			kind: change.kind,
			value: change.value,
			status: "open",
			saidBy: change.saidBy,
			source: change.source,
			thread,
			at,
			by,
		};

		if (change.replaces !== undefined) rule.replaces = known(list.rules, change.replaces, "rule").id;
		list.rules.push(rule);
	} else {
		rule = known(list.rules, change.id, "rule");
		mustBeOpen(rule);
		setRuleText(rule, change);
		Object.assign(rule, { saidBy: change.saidBy, source: change.source, thread, at, by });
	}

	// A draft cannot be used after its commit, so the rule is a copy.
	return { ...rule };
}

/** Fails when `rule` is not open. */
function mustBeOpen(rule: Rule): void {
	if (rule.status !== "open") throw new Error(`Rule ${rule.id} is ${rule.status}, not open`);
}

/** Sets on `rule` the name, the kind and the value of `text` that are given. */
function setRuleText(rule: Rule, text: Partial<Pick<Rule, "name" | "kind" | "value">>): void {
	if (text.name !== undefined) rule.name = text.name;

	if (text.kind !== undefined) rule.kind = text.kind;

	if (text.value !== undefined) rule.value = text.value;
}

/**
 * Makes the change `change` of the user for the caller `by`, and gives the rule. A decide puts an open rule in effect,
 * and retires the rule that it replaces when that rule is there and not retired. A retire ends an open or a decided
 * rule. An edit changes the text of a rule in any status, and makes the user its author with no source and no
 * thread. A create adds a decided rule of the user. A delete removes the rule; its ID is never given again.
 */
export async function changeRule(tx: Tx, change: RuleUserChange, by: string): Promise<Rule> {
	const list = await tx.doc(Rules);
	const at = Date.now();

	if (change.action === "create") {
		const { name, kind, value } = change;
		const created: Rule = { id: nextRuleId(list), name, kind, value, status: "decided", saidBy: "user", at, by };
		list.rules.push(created);

		return { ...created };
	}

	const rule = known(list.rules, change.id, "rule");

	switch (change.action) {
		case "decide": {
			mustBeOpen(rule);
			const replaced = list.rules.find((found) => found.id === rule.replaces);

			if (replaced !== undefined && replaced.status !== "retired")
				Object.assign(replaced, { status: "retired", at, by });
			Object.assign(rule, { status: "decided", at, by });

			return { ...rule };
		}

		case "retire":
			if (rule.status === "retired") throw new Error(`Rule ${rule.id} is retired`);
			Object.assign(rule, { status: "retired", at, by });

			return { ...rule };
		case "edit":
			setRuleText(rule, change);
			Object.assign(rule, { saidBy: "user", at, by });
			delete rule.source;
			delete rule.thread;

			return { ...rule };
		case "delete":
			list.last = highRuleId(list);
			list.rules.splice(list.rules.indexOf(rule), 1);

			return { ...rule };
	}
}

/**
 * The rules as the store has them, in ID order: with `filter`, only those of its kind and its status. A rule that an
 * older store wrote has a source and no thread; `readRules` gives its thread.
 */
export async function readStoredRules(
	reader: Pick<DocumentReader, "snapshot">,
	filter: RuleFilter,
	context: Context,
): Promise<RuleList> {
	const list = await reader.snapshot(Rules, context);

	const rules = (list?.rules ?? []).filter(
		(rule) =>
			(filter.kind === undefined || rule.kind === filter.kind) &&
			(filter.status === undefined || rule.status === filter.status),
	);

	return { rules: rules.map((rule) => ({ ...rule })) };
}

/**
 * The rules of `readStoredRules`, each rule with a source with the thread of its source. A rule that an older store
 * wrote has a source and no thread: it gets the thread from one lookup of its message in `storage`, the storage of
 * `harness`, and stays with no thread when the message is not there.
 */
export async function readRules(
	host: { readonly harness: Pick<DocumentReader, "snapshot">; readonly storage: Pick<Storage, "entry"> },
	filter: RuleFilter,
	context: Context,
): Promise<RuleList> {
	const list = await readStoredRules(host.harness, filter, context);

	await Promise.all(
		list.rules.map(async (rule) => {
			if (rule.source === undefined || rule.thread !== undefined) return;
			const found = await host.storage.entry(entryId(rule.source), context);

			if (found !== undefined) rule.thread = found.entry.conversationId;
		}),
	);

	return list;
}

/**
 * Writes the rules `rules` of a store file in `tx`, into a store with no rules. The source of each rule gets the new ID
 * of its message in `messages`, which maps the ID of each message of the file to its new ID and the new ID of its
 * thread, and its thread gets that new thread, whatever thread the file gives. `last` is the higher of `lastRule` and
 * the store.
 */
export async function loadRules(
	tx: Tx,
	rules: readonly Rule[],
	lastRule: number,
	messages: ReadonlyMap<number, { id: number; thread: number }>,
): Promise<void> {
	const list = await tx.doc(Rules);

	list.rules.push(
		...rules.map((fileRule) => {
			const { thread: _, ...rule } = fileRule;

			if (rule.source === undefined) return rule;
			const message = mappedId(messages, rule.source, "message");

			return { ...rule, source: message.id, thread: message.thread };
		}),
	);

	list.last = Math.max(lastRule, highRuleId(list));
}

/** The highest ID that a rule had, also a rule that is gone, or 0 when no rule was set. */
export async function readLastRuleId(reader: Pick<DocumentReader, "snapshot">, context: Context): Promise<number> {
	const list = await reader.snapshot(Rules, context);

	return list === undefined ? 0 : highRuleId(list);
}

/** The highest ID that a rule of `list` had. */
function highRuleId(list: RuleList & { last?: number }): number {
	return Math.max(list.last ?? 0, list.rules.at(-1)?.id ?? 0);
}

/** The next ID of a rule of `list`, recorded as its `last`. */
function nextRuleId(list: RuleList & { last?: number }): number {
	const id = highRuleId(list) + 1;
	list.last = id;

	return id;
}

/**
 * Lets a delete remove the message `id`: a rule that is not retired and has it as its source fails the delete, and a
 * retired rule with it as its source loses its source and its thread.
 */
export async function releaseSource(tx: Tx, id: number): Promise<void> {
	const list = await tx.doc(Rules);
	const named = list.rules.filter((rule) => rule.source === id);
	const live = named.find((rule) => rule.status !== "retired");

	if (live !== undefined) throw new Error(`Message ${id} is the source of rule ${live.id}`);

	for (const rule of named) {
		delete rule.source;
		delete rule.thread;
	}
}

/** The value in `ids` of the old ID `id` of a `name`. */
function mappedId<T>(ids: ReadonlyMap<number, T>, id: number, name: string): T {
	const found = ids.get(id);

	if (found === undefined) throw new Error(`Unknown ${name}: ${id}`);

	return found;
}
