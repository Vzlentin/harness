/**
 * A durable conversation drawn with Pi's own message and tool components.
 *
 * Adapted from `ChatView` in mavam/pi-agents, src/ui/attach.ts. MIT License, Copyright (c) 2026 Matthias Vallentin.
 */
import type { AssistantMessage, JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
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
	type ThemeColor,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { liveOf, userText } from "../dist/view-state.js";

// Pi's tool definitions differ in their schemas.
type AnyDefinition = ToolDefinition<any, any>;

/** Pi's renderers of the tools that children have under the same names. */
const RENDERERS = new Map<string, (cwd: string) => AnyDefinition>([
	["read", createReadToolDefinition],
	["bash", createBashToolDefinition],
	["edit", createEditToolDefinition],
	["write", createWriteToolDefinition],
	["grep", createGrepToolDefinition],
	["find", createFindToolDefinition],
	["ls", createLsToolDefinition],
]);

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

/** The transcript of one conversation view, updated in place as the view changes. */
export class ChatView {
	readonly transcript = new Container();
	/** The newest card for each call ID: providers can use a call ID again in a later turn. */
	private readonly tools = new Map<string, ToolExecutionComponent>();
	/** Every card shown, also the older ones whose call ID a later turn used again. */
	private readonly cards: ToolExecutionComponent[] = [];
	/** The cards that have no final result yet. */
	private readonly running = new Set<ToolExecutionComponent>();
	/** The call IDs whose cards the streamed answer made; its entry takes them over. */
	private readonly streamingCalls = new Set<string>();
	private readonly renderers = new Map<string, AnyDefinition>();
	private renderedEntryIds: EntryRecord["id"][] = [];
	private streaming: AssistantMessageComponent | undefined;
	/** Ctrl+O shows tool output in full, as in Pi. */
	private expanded = false;
	/** Pi's `hideThinkingBlock` setting: the answers show a label in place of their thinking. */
	private hideThinking = false;
	private readonly ui: TUI;
	private readonly cwd: string;
	/** Colors the lines that the transcript adds itself, such as `[compaction]`, in Pi's current theme. */
	private readonly color: (name: ThemeColor, text: string) => string;

	constructor(ui: TUI, cwd: string, color: (name: ThemeColor, text: string) => string) {
		this.ui = ui;
		this.cwd = cwd;
		this.color = color;
	}

	apply(view: ConversationView): void {
		const live = liveOf(view);
		this.syncTranscript(view.entries);
		const message = live.generation?.message;

		// A streamed answer without its entry was dropped, for example by a retry.
		if (message === undefined && this.streaming !== undefined) this.rebuild(view.entries);

		if (message !== undefined) this.syncStreaming(message);

		for (const slot of live.tools ?? []) {
			if (slot.status === "pending") continue;
			const component = this.card(slot.name, slot.callId);
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

	/** Shows tool output in full when `expanded` is true, else collapsed. */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;

		for (const card of this.cards) card.setExpanded(expanded);
		this.transcript.invalidate();
	}

	/** Hides the thinking of the answers when `hide` is true, else shows it. */
	setHideThinking(hide: boolean): void {
		this.hideThinking = hide;

		for (const child of this.transcript.children) {
			if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(hide);
		}

		this.transcript.invalidate();
	}

	/** Finishes the running cards: a running bash card keeps a timer until it gets a final result. */
	stopTimers(): void {
		for (const component of this.running) component.updateResult({ content: [], isError: false }, false);
		this.running.clear();
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
		this.stopTimers();
		this.transcript.clear();
		this.cards.length = 0;
		this.tools.clear();
		this.streamingCalls.clear();
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
			const component =
				this.streaming ?? new AssistantMessageComponent(undefined, this.hideThinking, getMarkdownTheme());

			if (this.streaming === undefined) this.transcript.addChild(component);
			this.streaming = undefined;
			component.updateContent(message, false);
			// Only an answer that asks for tools runs its calls; an aborted, failed or cut answer never does.
			const ran = message.stopReason === "toolUse";

			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.streamingCalls.has(content.id);

				if (!ran && !streamed) continue;

				const card = streamed
					? this.card(content.name, content.id, content.arguments)
					: this.newCard(content.name, content.id, content.arguments);

				card.setArgsComplete();

				if (!ran) {
					const text = "Not run: the answer was interrupted.";
					card.updateResult({ content: [{ type: "text", text }], isError: true }, false);
					this.running.delete(card);
				}
			}

			this.streamingCalls.clear();
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const card = this.card(message.toolName, message.toolCallId);
			card.updateResult(displayedResult(message));
			this.running.delete(card);
		} else if (entry.kind === "pi.compaction") {
			this.addText(this.color("muted", "[compaction]"));

			if (message?.role === "user") this.addText(userText(message.content));
		} else if (entry.kind === "pi.reset") {
			this.addText(this.color("muted", "[new context]"));
		}
	}

	private syncStreaming(message: AssistantMessage): void {
		if (this.streaming === undefined) {
			this.streaming = new AssistantMessageComponent(undefined, this.hideThinking, getMarkdownTheme());
			this.transcript.addChild(this.streaming);
		}

		this.streaming.updateContent(message, true);

		for (const content of message.content) {
			if (content.type !== "toolCall") continue;

			if (this.streamingCalls.has(content.id)) this.card(content.name, content.id, content.arguments);
			else this.newCard(content.name, content.id, content.arguments);
			this.streamingCalls.add(content.id);
		}
	}

	private renderer(toolName: string): AnyDefinition | undefined {
		let definition = this.renderers.get(toolName);

		if (definition === undefined) {
			const create = RENDERERS.get(toolName);

			if (create === undefined) return undefined;
			definition = create(this.cwd);
			this.renderers.set(toolName, definition);
		}

		return definition;
	}

	/** The newest card of a call, or a new card when the call has none. */
	private card(toolName: string, toolCallId: string, args?: JsonObject): ToolExecutionComponent {
		const existing = this.tools.get(toolCallId);

		if (existing === undefined) return this.newCard(toolName, toolCallId, args ?? {});

		if (args !== undefined) existing.updateArgs(args);

		return existing;
	}

	/** A new card of a call, also for a call ID that an earlier turn used. */
	private newCard(toolName: string, toolCallId: string, args: JsonObject): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{},
			this.renderer(toolName),
			this.ui,
			this.cwd,
		);

		component.setExpanded(this.expanded);
		this.transcript.addChild(component);
		this.cards.push(component);
		this.running.add(component);
		this.tools.set(toolCallId, component);

		return component;
	}

	private addText(text: string): void {
		this.transcript.addChild(new Spacer(1));
		this.transcript.addChild(new Text(text, 1, 0));
	}
}
