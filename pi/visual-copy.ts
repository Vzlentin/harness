/**
 * `/vc`, the visual copy of the transcript: the user moves through the blocks of the agent messages and copies one,
 * and a text copy that holds a draft of a thread marks that draft sent.
 */
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { Message } from "../dist/protocol/index.js";
import { copyDiagram, copyImage, imageFile, NODE_SYSTEM, type System } from "./clipboard.ts";
import type { CopyResult } from "./copy-choice.ts";
import { VisualCopy } from "./copy-view.ts";
import type { Harness } from "./index.ts";
import { collectBlocks, contentWidth } from "./transcript.ts";

/** What `/vc` uses of the harness: the store of the project, to mark a copied draft sent. */
type VisualCopyHarness = Pick<Harness, "protocol" | "tool">;

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

		return;
	}

	if (result.kind === "text") await markDrafts(ctx, harness, result.text);
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

/** The text with each run of whitespace as one space, and without whitespace at its ends. */
function normalized(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Marks sent each draft of the threads of the project whose text the copied text holds, with the session as the caller.
 * A read or a mark that fails gives a warning: the copy is done.
 */
async function markDrafts(ctx: ExtensionContext, harness: VisualCopyHarness, text: string): Promise<void> {
	const { protocol, tool } = harness;
	const signal = ctx.signal ?? new AbortController().signal;
	const copied = normalized(text);
	let drafts: Message[];

	try {
		drafts = (await readMessages(harness, signal)).filter(
			(message) =>
				message.direction === "out" && message.state === "draft" && copied.includes(normalized(message.text)),
		);
	} catch (error) {
		ctx.ui.notify(`Could not read the drafts: ${protocol.errorMessage(error)}`, "warning");

		return;
	}

	const caller = ctx.sessionManager.getSessionId();

	for (const draft of drafts) {
		try {
			await tool.sendToHost({ type: "message", action: "mark", caller, message: draft.id, state: "sent" }, signal);
			ctx.ui.notify(`Draft ${draft.id} marked sent`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not mark draft ${draft.id} sent: ${protocol.errorMessage(error)}`, "warning");
		}
	}
}

/**
 * The messages of every thread of the project, from a host that the reads start when none runs. It throws when the host
 * replies with another object than a thread list or the messages of a thread.
 */
async function readMessages(harness: VisualCopyHarness, signal: AbortSignal): Promise<Message[]> {
	const { protocol, tool } = harness;
	const list = await tool.sendToHost({ type: "thread", action: "list" }, signal);

	if (!Value.Check(protocol.ThreadList, list)) throw new Error("The host replied with no threads");

	const reads = await Promise.all(
		list.threads.map((thread) => tool.sendToHost({ type: "thread", action: "read", id: thread.id }, signal)),
	);

	return reads.flatMap((reply) => {
		if (!Value.Check(protocol.ThreadMessages, reply)) throw new Error("The host replied with no messages");

		return reply.messages;
	});
}
