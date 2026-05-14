import { matchesKey } from "@mariozechner/pi-tui";
import type {
	UiComponentLike,
	UiRenderContext,
	UiWidgetEntry,
	UiWidgetPlacement,
} from "./contracts.ts";

// ABOUT: Generic widget host: instance reuse keyed on entry content identity,
// focus traversal (Tab/Shift-Tab) over focusable instances, Escape returns
// focus to the editor, Ctrl-C passes through, dispose cascades. Moved from
// slab/widget-host.ts in §T014 with no behavior change.

interface WidgetInstance {
	readonly key: string;
	readonly id: string;
	readonly placement: UiWidgetPlacement;
	readonly content: UiWidgetEntry["content"];
	readonly component: UiComponentLike;
	orderIndex: number;
}

export interface UiWidgetHostOptions {
	onInvalidate?: () => void;
}

function widgetKey(entry: UiWidgetEntry): string {
	return `${entry.placement}:${entry.id}`;
}

function isLines(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isComponent(value: unknown): value is UiComponentLike {
	return typeof value === "object"
		&& value !== null
		&& typeof (value as UiComponentLike).render === "function"
		&& typeof (value as UiComponentLike).invalidate === "function";
}

function isFocusable(instance: WidgetInstance): boolean {
	return typeof instance.component.handleInput === "function";
}

function setFocused(component: UiComponentLike, focused: boolean): void {
	if ("focused" in component) {
		(component as UiComponentLike & { focused: boolean }).focused = focused;
	}
}

function renderContent(entry: UiWidgetEntry, context: UiRenderContext): readonly string[] | UiComponentLike {
	if (typeof entry.content === "function") return entry.content(context);
	return entry.content;
}

export class UiWidgetHost {
	private readonly instances = new Map<string, WidgetInstance>();
	private focusedKey: string | undefined;
	private order = new Map<string, number>();

	constructor(private readonly options: UiWidgetHostOptions = {}) {}

	get focusedWidgetId(): string | undefined {
		const focused = this.focusedInstance();
		return focused?.id;
	}

	get activeWidgetCount(): number {
		return this.instances.size;
	}

	sync(widgets: readonly UiWidgetEntry[]): void {
		const active = new Map<string, UiWidgetEntry>();
		this.order = new Map();
		widgets.forEach((entry, index) => {
			const key = widgetKey(entry);
			active.set(key, entry);
			this.order.set(key, index);
		});

		for (const [key, instance] of this.instances) {
			const entry = active.get(key);
			if (entry && entry.content === instance.content) {
				instance.orderIndex = this.order.get(key) ?? instance.orderIndex;
				continue;
			}
			this.disposeInstance(key, instance);
		}

		if (this.focusedKey && !this.instances.has(this.focusedKey)) {
			this.focusedKey = undefined;
			this.invalidate();
		}
	}

	renderPlacement(widgets: readonly UiWidgetEntry[], placement: UiWidgetPlacement, context: UiRenderContext): string[] {
		this.sync(widgets);
		const lines: string[] = [];
		for (const entry of widgets) {
			if (entry.placement !== placement) continue;
			const rendered = this.renderEntry(entry, context);
			lines.push(...rendered);
		}
		return lines;
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, "ctrl+c")) return false;

		if (matchesKey(data, "tab")) {
			return this.focusNext();
		}

		if (matchesKey(data, "shift+tab")) {
			return this.focusPrevious();
		}

		if (matchesKey(data, "escape")) {
			return this.focusEditor();
		}

		const focused = this.focusedInstance();
		if (!focused?.component.handleInput) return false;
		focused.component.handleInput(data);
		focused.component.invalidate();
		this.invalidate();
		return true;
	}

	focusEditor(): boolean {
		if (!this.focusedKey) return false;
		this.setFocusedKey(undefined);
		return true;
	}

	dispose(): void {
		for (const [key, instance] of this.instances) {
			this.disposeInstance(key, instance);
		}
		this.instances.clear();
		this.focusedKey = undefined;
		this.order.clear();
	}

	private renderEntry(entry: UiWidgetEntry, context: UiRenderContext): readonly string[] {
		const key = widgetKey(entry);
		const existing = this.instances.get(key);
		if (existing && existing.content === entry.content) {
			return existing.component.render(context.width);
		}

		const content = renderContent(entry, context);
		if (isLines(content)) return content;
		if (!isComponent(content)) return [];

		const instance: WidgetInstance = {
			key,
			id: entry.id,
			placement: entry.placement,
			content: entry.content,
			component: content,
			orderIndex: this.order.get(key) ?? Number.MAX_SAFE_INTEGER,
		};
		this.instances.set(key, instance);
		setFocused(instance.component, this.focusedKey === key);
		return instance.component.render(context.width);
	}

	private focusableInstances(): WidgetInstance[] {
		return [...this.instances.values()]
			.filter(isFocusable)
			.sort((left, right) => left.orderIndex - right.orderIndex || left.key.localeCompare(right.key));
	}

	private focusedInstance(): WidgetInstance | undefined {
		return this.focusedKey ? this.instances.get(this.focusedKey) : undefined;
	}

	private focusNext(): boolean {
		const focusable = this.focusableInstances();
		if (focusable.length === 0) return false;

		if (!this.focusedKey) {
			this.setFocusedKey(focusable[0]?.key);
			return true;
		}

		const index = focusable.findIndex((instance) => instance.key === this.focusedKey);
		if (index < 0 || index === focusable.length - 1) {
			this.setFocusedKey(undefined);
			return true;
		}

		this.setFocusedKey(focusable[index + 1]?.key);
		return true;
	}

	private focusPrevious(): boolean {
		const focusable = this.focusableInstances();
		if (focusable.length === 0) return false;

		if (!this.focusedKey) {
			this.setFocusedKey(focusable.at(-1)?.key);
			return true;
		}

		const index = focusable.findIndex((instance) => instance.key === this.focusedKey);
		if (index <= 0) {
			this.setFocusedKey(undefined);
			return true;
		}

		this.setFocusedKey(focusable[index - 1]?.key);
		return true;
	}

	private setFocusedKey(key: string | undefined): void {
		if (this.focusedKey === key) return;
		const previous = this.focusedInstance();
		if (previous) setFocused(previous.component, false);
		this.focusedKey = key;
		const next = this.focusedInstance();
		if (next) setFocused(next.component, true);
		this.invalidate();
	}

	private disposeInstance(key: string, instance: WidgetInstance): void {
		setFocused(instance.component, false);
		instance.component.dispose?.();
		this.instances.delete(key);
	}

	private invalidate(): void {
		this.options.onInvalidate?.();
	}
}
