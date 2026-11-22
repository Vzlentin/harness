/**
 * The system prompt section of the decided rules of the project, which each conversation of the host gets by default. It
 * reads the rules at each request, so a change of a rule reaches a running agent at its next request.
 */
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { RULES_SECTION, rulesSection } from "../protocol/project.ts";
import type { StoreReader } from "./project-store.ts";

/** The extension of the section, which reads the rules from `store()`, the project store once the entry is open. */
export function rulesExtension(store: () => Pick<StoreReader, "rules">): Extension {
	return defineExtension({
		name: "harness-rules",
		sections: [section(RULES_SECTION, () => rulesSection(store().rules({ status: "decided" })))],
	});
}
