/**
 * `/rules`: the rules of the project of the session's host, and the changes that only the user makes to a rule.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type * as protocol from "../dist/protocol/index.js";
import type { Harness } from "./index.ts";

const NEW_RULE = "New rule";

/** The actions on a rule of each status. */
const ACTIONS: Readonly<Record<protocol.RuleStatus, readonly string[]>> = {
	open: ["Decide", "Retire", "Edit", "Delete"],
	decided: ["Retire", "Edit", "Delete"],
	retired: ["Edit", "Delete"],
};

type Scope = Parameters<Harness["projectTool"]["sendRuleList"]>[1];

/**
 * Registers `/rules`, whose caller is the session ID. With a UI, the user picks a rule, or a new one, then an action:
 * decide, retire, edit or delete. With no UI, it prints the list and changes nothing.
 */
export function registerRules(pi: ExtensionAPI, harness: Pick<Harness, "projectTool" | "protocol" | "tool">): void {
	const { projectTool, protocol, tool } = harness;

	pi.registerCommand("rules", {
		description: "List the rules of the project, and decide, retire, edit, create or delete one",
		handler: async (_args, ctx) => {
			const scope: Scope = { caller: ctx.sessionManager.getSessionId(), send: tool.sendToHost, signal: undefined };

			try {
				const { entries } = await projectTool.sendRuleList({}, scope);

				const order = entries.sort(
					(a, b) => protocol.RULE_STATES.indexOf(a.rule.status) - protocol.RULE_STATES.indexOf(b.rule.status),
				);

				if (!ctx.hasUI) {
					process.stdout.write(order.length === 0 ? "No rules\n" : order.map(({ line }) => `${line}\n`).join(""));

					return;
				}

				const chosen = await ctx.ui.select("Rules", [NEW_RULE, ...order.map(({ line }) => line)]);

				if (chosen === undefined) return;
				const picked = new Map(order.map(({ line, rule }) => [line, rule])).get(chosen);

				if (chosen !== NEW_RULE && picked === undefined) return;
				const change = picked === undefined ? await newRule(ctx) : await ruleChange(ctx, picked);

				if (change === undefined) return;
				const { text } = await projectTool.sendRuleChange(change, scope);
				ctx.ui.notify(text.trimEnd(), "info");
			} catch (error) {
				const message = protocol.errorMessage(error);

				if (ctx.hasUI) ctx.ui.notify(`harness: ${message}`, "error");
				else process.stderr.write(`harness: ${message}\n`);
			}
		},
	});
}

/** The rule that the user creates: a name, a kind and a value. Nothing when the user cancels one of them. */
async function newRule(ctx: ExtensionCommandContext): Promise<protocol.RuleUserChange | undefined> {
	const name = await ctx.ui.input("Name of the rule");

	if (!name?.trim()) return undefined;
	const kind = await ctx.ui.select("Kind of the rule", ["conduct", "domain"]);

	if (kind !== "conduct" && kind !== "domain") return undefined;
	const value = await ctx.ui.editor("What the rule says");

	if (!value?.trim()) return undefined;

	return { action: "create", name: name.trim(), kind, value: value.trim() };
}

/** The change that the user picks for `rule`. Nothing when the user cancels, or does not confirm a delete. */
async function ruleChange(
	ctx: ExtensionCommandContext,
	rule: protocol.Rule,
): Promise<protocol.RuleUserChange | undefined> {
	const action = await ctx.ui.select(`Rule ${rule.id}: ${rule.name}`, [...ACTIONS[rule.status]]);

	switch (action) {
		case "Decide":
			return { action: "decide", id: rule.id };
		case "Retire":
			return { action: "retire", id: rule.id };
		case "Delete":
			return (await ctx.ui.confirm("Delete the rule", `No list shows rule ${rule.id} again.`))
				? { action: "delete", id: rule.id }
				: undefined;
		case "Edit": {
			const name = await ctx.ui.input("Name of the rule", rule.name);

			if (name === undefined) return undefined;
			const value = await ctx.ui.editor("What the rule says", rule.value);

			if (value === undefined) return undefined;

			return {
				action: "edit",
				id: rule.id,
				...(name.trim() && { name: name.trim() }),
				...(value.trim() && { value: value.trim() }),
			};
		}

		default:
			return undefined;
	}
}
