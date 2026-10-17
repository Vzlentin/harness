/**
 * A durable conversation drawn with Pi's own message and tool components.
 *
 * Adapted from `ChatView` in mavam/pi-agents, src/ui/attach.ts. MIT License, Copyright (c) 2026 Matthias Vallentin.
 */
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getMarkdownTheme,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type ConversationView,
	type EntryRecord,
	InboxDoc,
	type InboxState,
	LiveDoc,
	type LiveState,
} from "@earendil-works/pi-durable";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

// biome-ignore lint/suspicious/noExplicitAny: Pi's tool definitions differ in their schemas.
type AnyDefinition = ToolDefinition<any, any>;

/** Pi's renderers of the tools that children have under the same names. */
const RENDERERS: Record<string, (cwd: string) => AnyDefinition> = {
	read: createReadToolDefinition,
	bash: createBashToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

export function liveOf(view: ConversationView): LiveState {
	return (view.docs[LiveDoc.definition.kind] as LiveState | undefined) ?? {};
}

export function inboxOf(view: ConversationView): InboxState {
	return (view.docs[InboxDoc.definition.kind] as InboxState | undefined) ?? { items: [] };
}

function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

const DIAGNOSTICS = /^<harness>\n([\s\S]*)\n<\/harness>$/;

/**
 * A tool result as Pi shows its own. pi-durable adds the diagnostics of a call for the model as a `<harness>` block, such
 * as `Command exited with code 3`, and the card shows them as plain lines.
 */
export function displayedResult(result: ToolResultMessage): ToolResultMessage {
	let changed = false;
	const content = result.content.map((block) => {
		const match = block.type === "text" ? DIAGNOSTICS.exec(block.text) : null;
		if (!match) return block;
		changed = true;
		const lines = (match[1] ?? "").split("\n").map((line) => line.replace(/^\[(error|warning|info)\] /, ""));
		return { type: "text" as const, text: `\n${lines.join("\n")}` };
	});
	return changed ? { ...result, content } : result;
}

/** The queued texts that Esc gives back to the editor, steers first, as Pi restores them. */
export function queuedTexts(inbox: InboxState): string[] {
	const steer: string[] = [];
	const followUp: string[] = [];
	for (const item of inbox.items) {
		if (item.mode === "write") continue;
		(item.mode === "steer" ? steer : followUp).push(userText(item.content as UserMessage["content"]));
	}
	return [...steer, ...followUp];
}

/** The queued inputs in inbox order, as Pi shows them: `Steer: …` or `Follow-up: …`, first line only. */
export function queuedLines(inbox: InboxState): string[] {
	return inbox.items.flatMap((item) => {
		if (item.mode === "write") return [];
		const text = userText(item.content as UserMessage["content"]).split("\n")[0] ?? "";
		return [`${item.mode === "steer" ? "Steer" : "Follow-up"}: ${text}`];
	});
}

/** What the conversation does now, as Pi's working indicator says it; empty when it does nothing. */
export function statusText(live: LiveState): string {
	const generation = live.generation;
	const compaction = live.compactions?.[0];
	const runningTool = live.tools?.find((slot) => slot.status === "running");
	if (generation?.retry !== undefined) return `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
	if (generation?.deferred !== undefined) return "Waiting for deferred response...";
	if (compaction !== undefined) {
		return compaction.retry
			? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...`
			: `Compacting (${compaction.reason})...`;
	}
	if (runningTool !== undefined) return `Running ${runningTool.name}... (esc to interrupt)`;
	if (live.run !== undefined) return "Working... (esc to interrupt)";
	return "";
}

/** The transcript of one conversation view, updated in place as the view changes. */
export class ChatView {
	readonly transcript = new Container();
	/** The newest card for each call ID: providers can use a call ID again in a later turn. */
	private readonly tools = new Map<string, ToolExecutionComponent>();
	/** Every card shown, also the older ones whose call ID a later turn used again. */
	private readonly cards: ToolExecutionComponent[] = [];
	/** The call IDs whose cards the streamed answer made; its entry takes them over. */
	private readonly streamingCalls = new Set<string>();
	private readonly renderers = new Map<string, AnyDefinition>();
	private renderedEntryIds: EntryRecord["id"][] = [];
	private streaming: AssistantMessageComponent | undefined;
	/** Ctrl+O shows tool output in full, as in Pi. */
	private expanded = false;
	private readonly ui: TUI;
	private readonly cwd: string;
	private readonly muted: (text: string) => string;

	constructor(ui: TUI, cwd: string, muted: (text: string) => string) {
		this.ui = ui;
		this.cwd = cwd;
		this.muted = muted;
	}

	apply(view: ConversationView): void {
		const live = liveOf(view);
		this.syncTranscript(view.entries);
		const message = live.generation?.message as AssistantMessage | undefined;
		// A streamed answer without its entry was dropped, for example by a retry.
		if (message === undefined && this.streaming !== undefined) this.rebuild(view.entries);
		if (message !== undefined) this.syncStreaming(message);
		for (const slot of live.tools ?? []) {
			if (slot.status === "pending") continue;
			const component = this.tool(slot.name, slot.callId);
			component.setArgsComplete();
			if (slot.status !== "running") continue;
			component.markExecutionStarted();
			if (slot.output !== undefined || slot.details !== undefined) {
				component.updateResult(
					{ content: [{ type: "text", text: slot.output ?? "" }], details: slot.details, isError: false },
					true,
				);
			}
		}
		this.transcript.invalidate();
	}

	/** Shows tool output in full, or collapses it again. */
	toggleExpanded(): void {
		this.expanded = !this.expanded;
		for (const card of this.cards) card.setExpanded(this.expanded);
		this.transcript.invalidate();
	}

	/** Finishes every card: a running bash card keeps a timer until it gets a final result. */
	dispose(): void {
		for (const component of this.cards) component.updateResult({ content: [], isError: false }, false);
		this.cards.length = 0;
		this.tools.clear();
		this.streamingCalls.clear();
	}

	private syncTranscript(entries: readonly EntryRecord[]): void {
		// A compaction or a reset replaces the head of the active transcript.
		if (this.renderedEntryIds.some((id, index) => entries[index]?.id !== id)) this.rebuild(entries);
		for (const entry of entries.slice(this.renderedEntryIds.length)) {
			this.addEntry(entry);
			this.renderedEntryIds.push(entry.id);
		}
	}

	private rebuild(entries: readonly EntryRecord[]): void {
		this.transcript.clear();
		this.dispose();
		this.renderedEntryIds = [];
		this.streaming = undefined;
		for (const entry of entries) {
			this.addEntry(entry);
			this.renderedEntryIds.push(entry.id);
		}
	}

	private addEntry(entry: EntryRecord): void {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") {
			this.transcript.addChild(new Spacer(1));
			this.transcript.addChild(new UserMessageComponent(userText(message.content), getMarkdownTheme()));
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const component = this.streaming ?? new AssistantMessageComponent(undefined, false, getMarkdownTheme());
			if (this.streaming === undefined) this.transcript.addChild(component);
			this.streaming = undefined;
			component.updateContent(message, false);
			// Only an answer that asks for tools runs its calls; an aborted, failed or cut answer never does.
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.streamingCalls.has(content.id);
				if (!ran && !streamed) continue;
				const card = this.tool(content.name, content.id, content.arguments, !streamed);
				card.setArgsComplete();
				if (!ran) {
					const text = "Not run: the answer was interrupted.";
					card.updateResult({ content: [{ type: "text", text }], isError: true }, false);
				}
			}
			this.streamingCalls.clear();
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			this.tool(message.toolName, message.toolCallId).updateResult(displayedResult(message));
		} else if (entry.kind === "pi.compaction") {
			this.addText(this.muted("[compaction]"));
			if (message?.role === "user") this.addText(userText(message.content));
		} else if (entry.kind === "pi.reset") {
			this.addText(this.muted("[new context]"));
		}
	}

	private syncStreaming(message: AssistantMessage): void {
		if (this.streaming === undefined) {
			this.streaming = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
			this.transcript.addChild(this.streaming);
		}
		this.streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.tool(content.name, content.id, content.arguments, !this.streamingCalls.has(content.id));
			this.streamingCalls.add(content.id);
		}
	}

	private renderer(toolName: string): AnyDefinition | undefined {
		let definition = this.renderers.get(toolName);
		if (definition === undefined) {
			const create = RENDERERS[toolName];
			if (create === undefined) return undefined;
			definition = create(this.cwd);
			this.renderers.set(toolName, definition);
		}
		return definition;
	}

	/** The card of a call; `fresh` starts a new card for a call ID that an earlier turn used. */
	private tool(toolName: string, toolCallId: string, args?: unknown, fresh = false): ToolExecutionComponent {
		const existing = fresh ? undefined : this.tools.get(toolCallId);
		if (existing !== undefined) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args ?? {},
			{},
			this.renderer(toolName),
			this.ui,
			this.cwd,
		);
		component.setExpanded(this.expanded);
		this.transcript.addChild(component);
		this.cards.push(component);
		this.tools.set(toolCallId, component);
		return component;
	}

	private addText(text: string): void {
		this.transcript.addChild(new Spacer(1));
		this.transcript.addChild(new Text(text, 1, 0));
	}
}
