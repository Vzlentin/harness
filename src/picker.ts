import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	fuzzyFilter,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ModelInfo } from "./protocol.ts";

/** The keys that the list of the model picker gets; the filter gets the others. */
const LIST_KEYS = ["up", "down", "enter", "escape", "pageUp", "pageDown"] as const;

/**
 * A filter over a list of models, fuzzy as Pi's model selector: typing narrows the list and keeps the selected model
 * when it still matches, ↑↓ move, Enter picks, Esc closes.
 */
export class ModelPicker implements Component {
	private readonly input = new Input();
	private readonly items: SelectItem[];
	private readonly modelOf = new Map<SelectItem, ModelInfo>();
	private readonly onSelect: (model: ModelInfo) => void;
	private readonly onCancel: () => void;
	private readonly border: (text: string) => string;
	private list: SelectList;
	focused = true;

	constructor(
		models: readonly ModelInfo[],
		current: ModelInfo | undefined,
		border: (text: string) => string,
		onSelect: (model: ModelInfo) => void,
		onCancel: () => void,
	) {
		this.items = models.map((model) => {
			const item = {
				value: `${model.provider}/${model.id}`,
				label: `${model.provider}/${model.id}`,
				description: model.name,
			};
			this.modelOf.set(item, model);
			return item;
		});
		this.border = border;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.input.focused = true;
		this.list = this.listOf(this.items);
		this.list.setSelectedIndex(current === undefined ? 0 : models.indexOf(current));
	}

	/** A frame with full-width lines, so the transcript does not show through. */
	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const body = [" Model", ...this.input.render(inner), ...this.list.render(inner)].map((line) => {
			const cut = truncateToWidth(line, inner);
			return `${this.border("│")}${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))}${this.border("│")}`;
		});
		return [this.border(`╭${"─".repeat(inner)}╮`), ...body, this.border(`╰${"─".repeat(inner)}╯`)];
	}

	handleInput(data: string): void {
		if (LIST_KEYS.some((key) => matchesKey(data, key))) {
			this.list.handleInput(data);
			return;
		}
		this.input.handleInput(data);
		const selected = this.list.getSelectedItem();
		const query = this.input.getValue();
		const items = fuzzyFilter(this.items, query, (item) => `${item.label} ${item.description ?? ""}`);
		this.list = this.listOf(items);
		this.list.setSelectedIndex(selected === null ? 0 : items.indexOf(selected));
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}

	private listOf(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, getSelectListTheme());
		list.onSelect = (item) => {
			const model = this.modelOf.get(item);
			if (model !== undefined) this.onSelect(model);
		};
		list.onCancel = this.onCancel;
		return list;
	}
}
