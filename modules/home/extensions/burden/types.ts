export type BurdenSectionKind =
	| "base-prompt"
	| "custom-system-prompt"
	| "agents"
	| "skills"
	| "tools"
	| "metadata"
	| "unknown";

export interface BurdenSourceRef {
	readonly kind: "prompt" | "file" | "skill" | "tool" | "unknown";
	readonly path?: string;
	readonly name?: string;
}

export interface BurdenEntry {
	readonly id: string;
	readonly label: string;
	readonly kind: BurdenSectionKind;
	readonly tokens: number;
	readonly chars: number;
	readonly content?: string;
	readonly source?: BurdenSourceRef;
	readonly children?: readonly BurdenEntry[];
}

export interface BurdenGap {
	readonly label: string;
	readonly reason: string;
	readonly tokens: number;
	readonly chars: number;
}

export interface BurdenReport {
	readonly generatedAt: string;
	readonly totalTokens: number;
	readonly totalChars: number;
	readonly contextWindow?: number;
	readonly sections: readonly BurdenEntry[];
	readonly unknown: BurdenEntry;
	readonly gaps: readonly BurdenGap[];
}
