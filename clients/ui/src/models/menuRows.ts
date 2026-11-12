import { browseRows, findModel, matchesQuery, NUMBERED_ROWS, onShortlist, sameModel } from "./catalog.ts";
import type { EffortLevel, ModelChoice, ModelEntry, ModelSettings } from "./settings.ts";

export const BROWSE_LIMIT = 8;

export interface ShortlistRow {
    readonly entry: ModelEntry;
    readonly current: boolean;
}

export interface ModelMenuRows {
    readonly searching: boolean;
    // The running model, when it is not on the shortlist and matches the search.
    readonly running: ModelEntry | undefined;
    readonly shortlist: readonly ShortlistRow[];
    // Catalog matches for a search, leaving out the shortlist and the running model.
    readonly browse: readonly ModelEntry[];
}

export function buildMenuRows(settings: ModelSettings, choice: ModelChoice | undefined, query: string): ModelMenuRows {
    const searching = query.trim().length > 0;
    const found = choice === undefined || onShortlist(settings, choice) ? undefined : findModel(settings, choice);
    const running = found !== undefined && (!searching || matchesQuery(found, query)) ? found : undefined;
    const shortlist = browseRows(settings.shortlist, query, "any").map((entry) => ({
        entry,
        current: choice !== undefined && sameModel(entry, choice),
    }));
    const browse = searching
        ? browseRows(settings.catalog, query, "any")
              .filter((entry) => !onShortlist(settings, entry) && (choice === undefined || !sameModel(entry, choice)))
              .slice(0, BROWSE_LIMIT)
        : [];
    return { searching, running, shortlist, browse };
}

// The rows the arrow keys step through, top to bottom. Unavailable shortlist rows are skipped.
export function pickOrder(rows: ModelMenuRows): readonly ModelEntry[] {
    const picks: ModelEntry[] = [];
    if (rows.running !== undefined) picks.push(rows.running);
    for (const row of rows.shortlist) {
        if (row.entry.available) picks.push(row.entry);
    }
    picks.push(...rows.browse);
    return picks;
}

// Keys 1 to NUMBERED_ROWS address the shortlist only while the search is empty.
export function numberKeySlot(key: string, searching: boolean): number | undefined {
    if (searching) return undefined;
    const value = Number(key);
    if (!Number.isInteger(value) || value < 1 || value > NUMBERED_ROWS) return undefined;
    return value - 1;
}

export function moveFocus(count: number, current: number | undefined, step: 1 | -1): number | undefined {
    if (count === 0) return undefined;
    if (current === undefined) return step === 1 ? 0 : count - 1;
    return Math.min(count - 1, Math.max(0, current + step));
}

export function providerLabel(settings: ModelSettings, provider: string): string {
    return settings.providers?.find((entry) => entry.id === provider)?.label ?? provider;
}

// A shortlist row shows the model's default effort; rows from outside the shortlist show the provider.
export function shortlistSub(settings: ModelSettings, entry: ModelEntry): string {
    if (entry.defaultLevel === undefined) return providerLabel(settings, entry.provider);
    return levelLabel(entry.levels, entry.defaultLevel);
}

export function rowTitle(settings: ModelSettings, entry: ModelEntry): string {
    return `${entry.label} · ${providerLabel(settings, entry.provider)}`;
}

// Names an effort from the levels of the model it belongs to. The catalog helper reads the
// current model's levels, which are wrong for a New Chat pick of another model.
export function levelLabel(levels: readonly EffortLevel[], id: string): string {
    return levels.find((level) => level.id === id)?.label ?? capitalize(id);
}

export function effortText(entry: ModelEntry, effort: string | undefined): string {
    return effort === undefined ? "Default" : levelLabel(entry.levels, effort);
}

const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// The host lists levels highest first; the slider runs from least to most effort.
export function sliderLevels(levels: readonly EffortLevel[]): readonly EffortLevel[] {
    const rank = (id: string): number => EFFORT_ORDER.indexOf(id);
    if (levels.every((level) => rank(level.id) >= 0)) return [...levels].sort((a, b) => rank(a.id) - rank(b.id));
    return [...levels].reverse();
}

// The slider position: the chosen level, else the model's default level, else the first level.
export function effortIndex(entry: ModelEntry, effort: string | undefined): number {
    const levels = sliderLevels(entry.levels);
    const chosen = effort === undefined ? -1 : levels.findIndex((level) => level.id === effort);
    if (chosen >= 0) return chosen;
    return Math.max(0, levels.findIndex((level) => level.id === entry.defaultLevel));
}

function capitalize(text: string): string {
    return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1).replaceAll("_", " ");
}
