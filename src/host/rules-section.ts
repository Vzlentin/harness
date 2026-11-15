/**
 * The system prompt section of the decided rules of the project, which each conversation of the host gets by default. It
 * reads the rules at each request, so a change of a rule reaches a running agent at its next request.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";
import { RULES_SECTION, rulesSection } from "../protocol/project.ts";
import { readRules } from "./project-rules.ts";

export const RulesSection = defineExtension({
	name: "harness-rules",
	sections: [
		section(RULES_SECTION, async (input, context) =>
			rulesSection((await readRules(input.read, { status: "decided" }, context)).rules),
		),
	],
});
