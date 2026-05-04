import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, Input, Spacer, Text, getKeybindings } from "@mariozechner/pi-tui";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

interface PickerItem {
	label: string;
	value: string;
	search: string;
}

class ScrollingSearchPicker extends Container {
	private readonly input = new Input();
	private readonly list = new Container();
	private filtered: PickerItem[];
	private selectedIndex = 0;

	constructor(
		private readonly title: string,
		private readonly items: PickerItem[],
		private readonly done: (value: string | undefined) => void,
		private readonly tui: { requestRender(): void },
	) {
		super();
		this.filtered = items;
		this.input.onSubmit = () => this.select();
		this.addChild(new Text(title, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Text("↑↓/jk navigate  enter select  esc cancel", 0, 0));
		this.updateList();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.move(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.move(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.select();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
		} else {
			this.input.handleInput(keyData);
			this.filter();
		}
		this.tui.requestRender();
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
		this.updateList();
	}

	private filter(): void {
		const query = this.input.getValue().toLowerCase().trim();
		this.filtered = query
			? this.items.filter((item) => item.search.toLowerCase().includes(query))
			: this.items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private select(): void {
		this.done(this.filtered[this.selectedIndex]?.value);
	}

	private updateList(): void {
		this.list.clear();
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filtered.length);

		for (let i = start; i < end; i++) {
			const item = this.filtered[i];
			if (!item) continue;
			this.list.addChild(new Text(`${i === this.selectedIndex ? "→" : " "} ${item.label}`, 0, 0));
		}

		if (this.filtered.length === 0) {
			this.list.addChild(new Text("  No matches", 0, 0));
		} else if (start > 0 || end < this.filtered.length) {
			this.list.addChild(new Text(`  (${this.selectedIndex + 1}/${this.filtered.length})`, 0, 0));
		}
	}
}

export async function selectModelFromMenu(ctx: ExtensionCommandContext, title: string, current?: string): Promise<string | undefined> {
	const entries = ctx.modelRegistry
		.getAll()
		.map((model) => {
			const spec = `${model.provider}/${model.id}`;
			return {
				label: `${model.id} [${model.provider}]${model.name !== model.id ? ` (${model.name})` : ""}${spec === current ? " ✓" : ""}`,
				value: spec,
				search: `${model.provider} ${model.id} ${model.name} ${spec}`,
			};
		})
		.sort((a, b) => {
			if (a.value === current) return -1;
			if (b.value === current) return 1;
			return a.label.localeCompare(b.label);
		});

	return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) =>
		new ScrollingSearchPicker(title, entries, done, tui),
	);
}

export async function selectThinkingFromMenu(ctx: ExtensionCommandContext, title: string, current?: ThinkingLevel): Promise<ThinkingLevel | undefined> {
	const choices = current ? [current, ...THINKING_LEVELS.filter((level) => level !== current)] : [...THINKING_LEVELS];
	const choice = await ctx.ui.select(title, choices);
	return THINKING_LEVELS.includes(choice as ThinkingLevel) ? choice as ThinkingLevel : undefined;
}

export default function modelPickerExtension(_pi: ExtensionAPI) {}
