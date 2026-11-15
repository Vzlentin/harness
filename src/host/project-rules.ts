/**
 * The rules of the project: one document of the session. An agent adds and changes an open rule, the user changes a
 * rule in any status, and the source of a rule is a message of a thread.
 */
import type { Context } from "@earendil-works/chord/context";
import type { DocumentReader, Tx } from "@earendil-works/pi-durable";
import {
	type Rule,
	type RuleFilter,
	type RuleList,
	type RuleSet,
	type RuleUserChange,
	RULES_KIND,
} from "../protocol/project.ts";
import { entryId, known, knownAuthor, MessageEntry, sessionDoc } from "./project-docs.ts";

/**
 * The rules, with `last`, the highest ID that a rule had, so that the ID of a deleted rule is never given again. A
 * store from before `last` has none, and its last rule has the highest ID.
 */
const Rules = sessionDoc<RuleList & { last?: number }>(RULES_KIND, () => ({ rules: [] }));

/**
 * Adds or changes a rule of an agent for the caller `by`, and gives it. A new rule is `open`, and `replaces` names the
 * rule that it replaces, which a decide of the new rule retires. Only an open rule changes.
 */
export async function setRule(tx: Tx, change: RuleSet, by: string): Promise<Rule> {
	if (change.id !== undefined && change.replaces !== undefined) {
		throw new Error("A change of a rule cannot replace a rule: set replaces on a new rule");
	}

	await knownSource(tx, change.source);
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
			at,
			by,
		};

		if (change.replaces !== undefined) rule.replaces = known(list.rules, change.replaces, "rule").id;
		list.rules.push(rule);
	} else {
		rule = known(list.rules, change.id, "rule");
		mustBeOpen(rule);
		setRuleText(rule, change);
		Object.assign(rule, { saidBy: change.saidBy, source: change.source, at, by });
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
 * rule. An edit changes the text of a rule in any status, and makes the user its author with no source. A create adds
 * a decided rule of the user. A delete removes the rule; its ID is never given again.
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

			return { ...rule };
		case "delete":
			list.last = highRuleId(list);
			list.rules.splice(list.rules.indexOf(rule), 1);

			return { ...rule };
	}
}

/** The rules, in ID order: with `filter`, only those of its kind and its status. */
export async function readRules(
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
 * Writes the rules `rules` of a store file in `tx`, into a store with no rules. The source of each rule gets the new ID
 * of its message in `messageIds`, which maps the ID of each message of the file to its new ID. `last` is the higher of
 * `lastRule` and the store.
 */
export async function loadRules(
	tx: Tx,
	rules: readonly Rule[],
	lastRule: number,
	messageIds: ReadonlyMap<number, number>,
): Promise<void> {
	const list = await tx.doc(Rules);

	list.rules.push(
		...rules.map((rule) =>
			rule.source === undefined ? rule : { ...rule, source: mappedId(messageIds, rule.source, "message") },
		),
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

async function knownSource(tx: Tx, id: number): Promise<void> {
	if ((await tx.entry(MessageEntry, entryId(id))) === undefined) throw new Error(`Unknown message: ${id}`);
}

/** The new ID of the old ID `id` of a `name` in `ids`. */
function mappedId(ids: ReadonlyMap<number, number>, id: number, name: string): number {
	const found = ids.get(id);

	if (found === undefined) throw new Error(`Unknown ${name}: ${id}`);

	return found;
}
