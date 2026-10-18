import { homedir } from "node:os";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import type { ConversationView, EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChildInfo } from "./protocol.ts";
import { bold, color } from "./theme.ts";
import { usageOf } from "./view-state.ts";

/** One line, cut to the width, with `hints` at the right end: the first hints go when they do not all fit. */
export class Line implements Component {
	text = "";
	hints: readonly string[] = [];
	style: (text: string) => string = (text) => text;
	render(width: number): string[] {
		for (let first = 0; first < this.hints.length; first++) {
			const right = `${this.hints.slice(first).join(" · ")} `;
			const gap = width - visibleWidth(this.text) - visibleWidth(right);

			if (gap >= 2) return [`${this.text}${" ".repeat(gap)}${this.style(right)}`];
		}

		return [truncateToWidth(this.text, width)];
	}
	invalidate(): void {}
}

/** `harness │ <title> │ <cwd> │ <state>`. */
export function headerText(child: ChildInfo, title: string): string {
	const state =
		child.state === "busy"
			? color("warning", "◉ busy")
			: child.state === "idle"
				? color("success", "● idle")
				: color("error", "⊗ error");

	return ` ${[bold(color("accent", "harness")), title, color("muted", tildePath(child.cwd)), state].join(
		color("borderMuted", "  │  "),
	)}`;
}

/**
 * `<provider>/<model> · <thinking> │ <tokens> tok $<cost> │ <used>%/<window> ctx`. The context part shows when
 * `contextWindow` is known and the child has answered once.
 */
export function footerText(child: ChildInfo, view: ConversationView, contextWindow: number | undefined): string {
	const usage = totalUsage(usageOf(view));
	const used = lastUsage(view.entries);

	const context =
		contextWindow === undefined || contextWindow === 0 || used === undefined
			? []
			: [`${((100 * used) / contextWindow).toFixed(1)}%/${compactCount(contextWindow)} ctx`];

	return ` ${color(
		"muted",
		[
			`${child.provider}/${child.model} · ${child.thinking}`,
			`${compactCount(usage.tokens)} tok $${usage.cost.toFixed(3)}`,
			...context,
		].join(" │ "),
	)}`;
}

type Totals = { tokens: number; cost: number };

/** The tokens and the cost of every model request of the conversation. */
function totalUsage(usage: UsageState | undefined): Totals {
	let tokens = 0;
	let cost = 0;

	for (const model of Object.values(usage?.models ?? {})) {
		tokens += model.totalTokens;
		cost += model.cost.total;
	}

	return { tokens, cost };
}

function compactCount(count: number): string {
	return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

function tildePath(path: string): string {
	const home = homedir();

	return home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** The prompt and output tokens of the last answer, which fill the context window of the next request. */
function lastUsage(entries: readonly EntryRecord[]): number | undefined {
	for (const entry of entries.toReversed()) {
		const message = entry.model?.[0];

		if (entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;

		return calculateContextTokens(message.usage);
	}

	return undefined;
}
