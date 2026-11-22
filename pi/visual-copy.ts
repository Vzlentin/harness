/** `/vc`, the visual copy of the transcript: the user moves through the blocks of the agent messages and copies one. */
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyDiagram, copyImage, imageFile, NODE_SYSTEM, type System } from "./clipboard.ts";
import type { CopyResult } from "./copy-choice.ts";
import { VisualCopy } from "./copy-view.ts";
import type { Harness } from "./index.ts";
import { collectBlocks, contentWidth } from "./transcript.ts";

/** What `/vc` uses of the harness: the protocol, for the text of an error. */
type VisualCopyHarness = Pick<Harness, "protocol">;

/**
 * Registers `/vc` and its shortcut `ctrl+shift+y` on `system`. A shortcut keeps the draft in the editor, which a typed
 * `/vc` would replace.
 */
export function registerVisualCopy(pi: ExtensionAPI, harness: VisualCopyHarness, system: System = NODE_SYSTEM): void {
	const run = (ctx: ExtensionContext) => visualCopy(ctx, harness, system);

	pi.registerCommand("vc", {
		description: "Visual copy: move through agent message blocks in the transcript and copy them",
		handler: async (_args, ctx) => run(ctx),
	});

	pi.registerShortcut("ctrl+shift+y", { description: "Visual copy (/vc)", handler: run });
}

async function visualCopy(ctx: ExtensionContext, harness: VisualCopyHarness, system: System): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/vc requires interactive mode", "error");

		return;
	}

	const result = await ctx.ui.custom<CopyResult | undefined>((tui, theme, _keybindings, done) => {
		const document = tui.children[0];
		const blocks = document ? collectBlocks(document, contentWidth(tui)) : [];

		if (blocks.length > 0) return new VisualCopy(tui, theme, blocks, done);
		ctx.ui.notify("No agent messages to copy yet", "warning");
		queueMicrotask(() => done(undefined));

		return { render: () => [], invalidate: () => {} };
	});

	if (result === undefined) return;

	try {
		await copyResult(ctx, result, system);
	} catch (error) {
		ctx.ui.notify(`Copy failed: ${harness.protocol.errorMessage(error)}`, "error");
	}
}

function describe(text: string): string {
	const lines = text.split("\n");

	const preview =
		lines
			.find((l) => l.trim())
			?.trim()
			.slice(0, 60) ?? "";

	return `Copied ${lines.length} line${lines.length === 1 ? "" : "s"}: ${preview}`;
}

/** Puts the result on the clipboard, and tells the user what it copied. */
async function copyResult(ctx: ExtensionContext, result: CopyResult, system: System): Promise<void> {
	switch (result.kind) {
		case "image": {
			const { image } = result;

			if (!result.path) {
				await copyImage(image, system);
				ctx.ui.notify(`Copied image${image.path ? `: ${image.path}` : ""}`, "info");

				return;
			}

			const path = image.path && existsSync(image.path) ? image.path : imageFile(image);
			await system.copyText(path);
			ctx.ui.notify(`Copied path: ${path}`, "info");

			return;
		}

		case "diagram": {
			const size = await copyDiagram(result.diagram, system);
			ctx.ui.notify(`Copied diagram image (${size})`, "info");

			return;
		}

		case "text":
			await system.copyText(result.text);
			ctx.ui.notify(describe(result.text), "info");
	}
}
