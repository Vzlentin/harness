/**
 * The lines that a command shows: a notification with a UI, otherwise a line on stdout or stderr.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Shows `line` as a notification of `type` with a UI. With no UI, it writes an info line to stdout, and an error line to
 * stderr.
 */
export function report(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">, line: string, type: "info" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(line, type);
	else (type === "info" ? process.stdout : process.stderr).write(`${line}\n`);
}

/** Shows `harness: <message of cause>` as an error. */
export function reportError(
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
	errorMessage: (cause: unknown) => string,
	cause: unknown,
): void {
	report(ctx, `harness: ${errorMessage(cause)}`, "error");
}
