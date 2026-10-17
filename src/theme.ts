import type { Theme } from "@earendil-works/pi-coding-agent";

// Pi gives its theme object only to extensions. Pi's cards color with the theme that `initTheme()` sets in this module,
// so the viewer loads the same module by its path to color its own lines the same way. The path is not in the `exports`
// of pi-coding-agent, so it holds only for the pinned version 1.3.0.
const piTheme = (await import(
	new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as { readonly theme: Theme };

export function color(name: Parameters<Theme["fg"]>[0], text: string): string {
	return piTheme.theme.fg(name, text);
}

export function bold(text: string): string {
	return piTheme.theme.bold(text);
}
