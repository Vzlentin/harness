/**
 * The footer of a mirror session. It has the layout of Pi's footer, with the agent in place of the local Pi session,
 * which has no messages: the agent's working directory and name, the tokens and the cost of its requests, the context
 * of its last answer, and its model.
 */
import { homedir } from "node:os";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import * as coding from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Mirror } from "../dist/mirror.js";
import type { ChildInfo } from "../dist/protocol.js";
import { lastAnswerUsage, usageTotals } from "../dist/view-state.js";

/** What the footer shows: the agent and its conversation. */
export type FooterState = { readonly child: ChildInfo; readonly view: Mirror["view"] };

export class MirrorFooter implements Component {
	readonly #theme: Theme;
	readonly #data: ReadonlyFooterDataProvider;
	readonly #models: ExtensionContext["modelRegistry"];
	/** The working directory of Pi. The Git branch of the footer data is the one of this directory. */
	readonly #cwd: string;
	readonly #state: () => FooterState;

	constructor(
		theme: Theme,
		data: ReadonlyFooterDataProvider,
		models: ExtensionContext["modelRegistry"],
		cwd: string,
		state: () => FooterState,
	) {
		this.#theme = theme;
		this.#data = data;
		this.#models = models;
		this.#cwd = cwd;
		this.#state = state;
	}

	render(width: number): string[] {
		const theme = this.#theme;
		const { child, view } = this.#state();
		const lines = [truncateToWidth(theme.fg("dim", this.#place(child)), width, theme.fg("dim", "..."))];
		lines.push(this.#stats(child, view, width));

		const statuses = [...this.#data.getExtensionStatuses().entries()]
			.toSorted(([first], [second]) => first.localeCompare(second))
			.map(([, text]) =>
				text
					.replace(/[\r\n\t]/g, " ")
					.replace(/ +/g, " ")
					.trim(),
			);

		if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));

		return lines;
	}

	invalidate(): void {}

	/** `<cwd> (<branch>) • <name>`. The branch shows when the agent works in the directory of Pi. */
	#place(child: ChildInfo): string {
		const branch = child.cwd === this.#cwd ? this.#data.getGitBranch() : null;
		const cwd = branch ? `${tildePath(child.cwd)} (${branch})` : tildePath(child.cwd);

		return `${cwd} • ${child.name ?? child.handle}`;
	}

	/** The tokens, the cost and the context on the left, and the model and the thinking level on the right. */
	#stats(child: ChildInfo, view: Mirror["view"], width: number): string {
		const theme = this.#theme;
		const totals = usageTotals(view);
		const last = lastAnswerUsage(view);
		const model = this.#models.find(child.provider, child.model);
		const subscription = model !== undefined && this.#models.isUsingOAuth(model);
		const parts: string[] = [];

		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);

		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);

		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);

		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		const prompt = last === undefined ? 0 : last.input + last.cacheRead + last.cacheWrite;

		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && last !== undefined && prompt > 0) {
			parts.push(`CH${((last.cacheRead / prompt) * 100).toFixed(1)}%`);
		}

		if (totals.cost || subscription) parts.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
		const contextWindow = model?.contextWindow ?? 0;

		if (contextWindow > 0) {
			const percent = last === undefined ? 0 : (coding.calculateContextTokens(last) / contextWindow) * 100;
			const context = `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
			parts.push(percent > 90 ? theme.fg("error", context) : percent > 70 ? theme.fg("warning", context) : context);
		}

		const name =
			model === undefined || model.reasoning
				? `${child.model} • ${child.thinking === "off" ? "thinking off" : child.thinking}`
				: child.model;

		const left = truncateToWidth(parts.join(" "), width, "...");
		const withProvider = `(${child.provider}) ${name}`;

		const right =
			this.#data.getAvailableProviderCount() > 1 && visibleWidth(left) + 2 + visibleWidth(withProvider) <= width
				? withProvider
				: name;

		const room = width - visibleWidth(left);
		const shown = room >= 2 + visibleWidth(right) ? right : truncateToWidth(right, Math.max(0, room - 2), "");
		const padding = " ".repeat(Math.max(0, room - visibleWidth(shown)));

		return theme.fg("dim", left) + theme.fg("dim", padding + shown);
	}
}

/** `path` with the home directory as `~`. */
export function tildePath(path: string): string {
	const home = homedir();

	return home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** A token count as Pi's footer shows it: `950`, `1.2k`, `45k`, `1.5M`. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();

	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;

	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;

	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;

	return `${Math.round(count / 1_000_000)}M`;
}
