import type {
    VeraClientContextComponent,
    VeraClientContextSnapshot,
} from "../../../src/sdk/context.ts";

export type ContextResponsiveMode = "wide" | "narrow";

export interface ContextCategory {
    readonly label: string;
    readonly tokens: number;
    readonly count: number;
    readonly components: readonly VeraClientContextComponent[];
}

export type ContextGridCellState = "used" | "free" | "reserve";

export interface ContextGridCell {
    readonly state: ContextGridCellState;
    readonly glyph: string;
    readonly category?: string;
}

export interface ContextGrid {
    readonly columns: number;
    readonly rows: readonly (readonly ContextGridCell[])[];
    readonly usedTokens: number;
    readonly freeTokens: number;
    readonly reserveTokens: number;
}

export interface ContextSuggestion {
    readonly tone: "warning" | "tip";
    readonly text: string;
    readonly estimatedSaving: number;
}

export interface ContextReport {
    readonly snapshot: VeraClientContextSnapshot;
    readonly categories: readonly ContextCategory[];
    readonly grid?: ContextGrid;
    readonly headline: string;
    readonly detail: readonly VeraClientContextComponent[];
    readonly suggestions: readonly ContextSuggestion[];
}

const CATEGORY_ORDER = [
    "System prompt",
    "System tools",
    "Custom agents",
    "Memory files",
    "Skills",
    "Messages",
    "Extension tools",
] as const;

const PARTIAL_GLYPHS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

export function contextResponsiveMode(width: number): ContextResponsiveMode {
    return width < 80 ? "narrow" : "wide";
}

export function contextCategories(
    snapshot: VeraClientContextSnapshot,
): readonly ContextCategory[] {
    const grouped = new Map<string, {
        tokens: number;
        count: number;
        components: VeraClientContextComponent[];
    }>();
    for (const component of snapshot.projection?.components ?? []) {
        const label = categoryLabel(component);
        const prior = grouped.get(label) ?? { tokens: 0, count: 0, components: [] };
        prior.tokens += component.estimatedTokens;
        prior.count += component.count;
        prior.components.push(component);
        grouped.set(label, prior);
    }
    return [...grouped.entries()]
        .map(([label, value]) => ({ label, ...value }))
        .sort((left, right) => {
            const order = CATEGORY_ORDER.indexOf(left.label as typeof CATEGORY_ORDER[number])
                - CATEGORY_ORDER.indexOf(right.label as typeof CATEGORY_ORDER[number]);
            return order !== 0 ? order : right.tokens - left.tokens;
        });
}

export function contextGrid(
    snapshot: VeraClientContextSnapshot,
    columns: number,
): ContextGrid | undefined {
    const capacity = snapshot.model?.capacity;
    const headline = snapshot.headline;
    const projection = snapshot.projection;
    if (capacity === undefined || headline === undefined || projection === undefined) {
        return undefined;
    }
    const safeColumns = columns === 5 ? 5 : 10;
    const rows = Math.ceil(100 / safeColumns);
    const usedTokens = Math.max(0, headline.tokens);
    const trigger = contextCompactionTrigger(snapshot) ?? capacity;
    const freeTokens = Math.max(0, trigger - usedTokens);
    const reserveTokens = Math.max(0, capacity - Math.max(trigger, usedTokens));
    const cells = Array.from({ length: 100 }, (_, index) =>
        gridCell(index, 100, capacity, usedTokens, trigger, projection.components)
    );
    return {
        columns: safeColumns,
        rows: Array.from({ length: rows }, (_, row) =>
            cells.slice(row * safeColumns, (row + 1) * safeColumns)
        ),
        usedTokens,
        freeTokens,
        reserveTokens,
    };
}

/** The scheduler fires at the earliest configured bound. */
export function contextCompactionTrigger(
    snapshot: VeraClientContextSnapshot,
): number | undefined {
    const capacity = snapshot.model?.capacity;
    const thresholds: number[] = [];
    if (snapshot.compaction?.triggerTokens !== undefined) {
        thresholds.push(snapshot.compaction.triggerTokens);
    }
    if (capacity !== undefined) {
        thresholds.push(
            capacity * (snapshot.compaction?.triggerFraction ?? 0.82),
        );
        thresholds.push(capacity);
    }
    return thresholds.length === 0 ? undefined : Math.min(...thresholds);
}

export function contextSuggestions(
    snapshot: VeraClientContextSnapshot,
): readonly ContextSuggestion[] {
    const suggestions: ContextSuggestion[] = [];
    const headline = snapshot.headline;
    const trigger = contextCompactionTrigger(snapshot);
    if (headline !== undefined && trigger !== undefined) {
        if (headline.tokens >= trigger) {
            suggestions.push({
                tone: "warning",
                text: "Auto-compaction is due for the next turn.",
                estimatedSaving: 0,
            });
        } else if (headline.tokens >= trigger * 0.9) {
            suggestions.push({
                tone: "warning",
                text: "Context is close to the auto-compaction window.",
                estimatedSaving: 0,
            });
        }
    }
    for (const category of contextCategories(snapshot)) {
        if (headline === undefined || headline.tokens === 0) continue;
        if (category.label === "Messages" && category.tokens >= headline.tokens * 0.2) {
            suggestions.push({
                tone: "warning",
                text: "Recent messages are using a material share of context.",
                estimatedSaving: category.tokens,
            });
        }
        if (
            (category.label === "Memory files" || category.label === "System prompt")
            && category.tokens >= headline.tokens * 0.15
        ) {
            suggestions.push({
                tone: "tip",
                text: `${category.label} is a material share of context; trim it to save tokens.`,
                estimatedSaving: category.tokens,
            });
        }
    }
    return suggestions.sort((left, right) =>
        toneRank(left.tone) - toneRank(right.tone)
        || right.estimatedSaving - left.estimatedSaving
        || left.text.localeCompare(right.text)
    );
}

export function buildContextReport(
    snapshot: VeraClientContextSnapshot,
    detail: boolean,
    width: number,
): ContextReport {
    const categories = contextCategories(snapshot);
    const capacity = snapshot.model?.capacity;
    const headline = snapshot.headline === undefined
        ? "No completed model request yet"
        : `${formatTokens(snapshot.headline.tokens)} / ${capacity === undefined
            ? "?"
            : formatTokens(capacity)} tokens${
                capacity === undefined
                    ? ""
                    : ` (${Math.round(snapshot.headline.tokens / capacity * 100)}%)`
            }${snapshot.headline.estimated ? " · estimated" : ""}`;
    return {
        snapshot,
        categories,
        grid: contextGrid(snapshot, contextResponsiveMode(width) === "wide" ? 10 : 5),
        headline,
        detail: detail
            ? [...(snapshot.projection?.components ?? [])]
                .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
            : [],
        suggestions: contextSuggestions(snapshot),
    };
}

export function formatTokens(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
    if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
    return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function categoryLabel(component: VeraClientContextComponent): string {
    const id = component.id.toLowerCase();
    if (component.kind === "message") return "Messages";
    if (component.kind === "tool_schema") {
        return component.owner === "core" || component.owner === "engine"
            ? "System tools"
            : "Extension tools";
    }
    if (id.includes("memory") || id.includes("project-instruction")) {
        return "Memory files";
    }
    if (id.includes("skill")) return "Skills";
    if (id.includes("agent")) return "Custom agents";
    return "System prompt";
}

function gridCell(
    index: number,
    cellCount: number,
    capacity: number,
    used: number,
    trigger: number,
    components: readonly VeraClientContextComponent[],
): ContextGridCell {
    const start = index / cellCount * capacity;
    const end = (index + 1) / cellCount * capacity;
    const covered = Math.max(0, Math.min(end, used) - start);
    if (covered > 0) {
        const fraction = covered / (end - start);
        const component = componentAt(start, components, used);
        return {
            state: "used",
            glyph: fraction >= 1
                ? "█"
                : PARTIAL_GLYPHS[Math.max(0, Math.ceil(fraction * 8) - 1)]!,
            ...(component === undefined ? {} : { category: categoryLabel(component) }),
        };
    }
    return start < trigger
        ? { state: "free", glyph: "·" }
        : { state: "reserve", glyph: "░" };
}

function componentAt(
    start: number,
    components: readonly VeraClientContextComponent[],
    used: number,
): VeraClientContextComponent | undefined {
    let cursor = 0;
    for (const component of components) {
        cursor += component.estimatedTokens;
        if (start < cursor) return component;
    }
    return used > 0 ? components.at(-1) : undefined;
}

function toneRank(tone: ContextSuggestion["tone"]): number {
    return tone === "warning" ? 0 : 1;
}
