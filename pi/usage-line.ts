/** The usage line of a mirror session, above the editor, as Pi's footer shows the usage of its own session. */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import * as coding from "@earendil-works/pi-coding-agent";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ChildInfo, childTitle } from "../dist/protocol.js";
import type * as viewState from "../dist/view-state.js";

/** The functions of harness that the usage line uses. */
type UsageFunctions = { readonly childTitle: typeof childTitle } & Pick<
	typeof viewState,
	"lastAnswerUsage" | "usageTotals"
>;

/**
 * The title of the agent, the tokens and the cost of its model requests and tool results, and the context of its last
 * answer that did not abort or fail, against the context window of its model, as Pi's footer shows them for its own
 * session.
 */
export function usageLine(
	theme: Theme,
	models: ExtensionContext["modelRegistry"],
	child: ChildInfo,
	view: ConversationView,
	harness: UsageFunctions,
): string {
	const totals = harness.usageTotals(view);
	const last = harness.lastAnswerUsage(view);
	const model = models.find(child.provider, child.model);
	const subscription = model !== undefined && models.isUsingOAuth(model);
	const usage: string[] = [];

	if (totals.input) usage.push(`↑${formatTokens(totals.input)}`);

	if (totals.output) usage.push(`↓${formatTokens(totals.output)}`);

	if (totals.cacheRead) usage.push(`R${formatTokens(totals.cacheRead)}`);

	if (totals.cacheWrite) usage.push(`W${formatTokens(totals.cacheWrite)}`);

	if (totals.cost || subscription) usage.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
	const parts = [harness.childTitle(child)];

	if (usage.length > 0) parts.push(usage.join(" "));
	const contextWindow = model?.contextWindow ?? 0;

	if (contextWindow > 0) {
		const percent = last === undefined ? 0 : (coding.calculateContextTokens(last) / contextWindow) * 100;
		const context = `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
		parts.push(percent > 90 ? theme.fg("error", context) : percent > 70 ? theme.fg("warning", context) : context);
	}

	return theme.fg("dim", parts.join(" • "));
}

/** A token count as Pi's footer shows it: `950`, `1.2k`, `45k`, `1.5M`. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();

	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;

	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;

	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;

	return `${Math.round(count / 1_000_000)}M`;
}
