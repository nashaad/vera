import type { ModelEntry, ModelSettings, Pricing } from "./settings.ts";

export interface ModelRef {
    readonly provider?: string;
    readonly model: string;
}

export const INTELLIGENCE_CUTOFFS = ["any", "1400", "1450", "1500", "1550", "1600"] as const;
export type IntelligenceCutoff = (typeof INTELLIGENCE_CUTOFFS)[number];

// The composer's quick menu numbers this many shortlist rows.
export const NUMBERED_ROWS = 4;

// An entry with no provider matches any provider: the session reports a bare model id
// when its provider is the home default.
export function sameModel(entry: ModelRef, other: ModelRef): boolean {
    if (entry.model !== other.model) return false;
    return entry.provider === undefined || other.provider === undefined || entry.provider === other.provider;
}

export function onShortlist(settings: ModelSettings, ref: ModelRef): boolean {
    return settings.shortlist.some((entry) => sameModel(entry, ref));
}

// The shortlist copy wins: it carries the display name the person gave it.
export function findModel(settings: ModelSettings, ref: ModelRef): ModelEntry | undefined {
    return settings.shortlist.find((entry) => sameModel(entry, ref))
        ?? settings.catalog.find((entry) => sameModel(entry, ref));
}

export function currentModel(settings: ModelSettings): ModelEntry | undefined {
    return findModel(settings, settings);
}

export function modelName(settings: ModelSettings, ref: ModelRef): string {
    return findModel(settings, ref)?.label ?? ref.model;
}

// The composer pill's name: the model without its vendor prefix.
export function shortModelName(settings: ModelSettings, ref: ModelRef): string {
    const entry = findModel(settings, ref);
    return entry?.shortLabel ?? entry?.label ?? ref.model;
}

// Every model either list holds, shortlist first, one row per provider and model.
export function allModels(settings: ModelSettings): readonly ModelEntry[] {
    const rows = [...settings.shortlist];
    for (const entry of settings.catalog) {
        if (!rows.some((row) => row.provider === entry.provider && row.model === entry.model)) rows.push(entry);
    }
    return rows;
}

export function matchesQuery(entry: ModelEntry, query: string): boolean {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const haystack = `${entry.label} ${entry.provider} ${entry.model}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
}

export function passesCutoff(entry: ModelEntry, cutoff: IntelligenceCutoff): boolean {
    if (cutoff === "any") return true;
    return entry.waScore !== undefined && entry.waScore >= Number(cutoff);
}

// The resting list hides what the catalog marks hidden; a search reaches every model.
export function browseRows(
    rows: readonly ModelEntry[],
    query: string,
    cutoff: IntelligenceCutoff,
): readonly ModelEntry[] {
    const searching = query.trim().length > 0;
    return rows.filter((entry) => (searching || !entry.hidden) && matchesQuery(entry, query) && passesCutoff(entry, cutoff));
}

// Vera weighs input three to one against output.
export function blendedRate(pricing: Pricing | undefined): number | undefined {
    return pricing === undefined ? undefined : (3 * pricing.input + pricing.output) / 4;
}

export function formatRate(value: number): string {
    const rounded = Math.round(value * 100) / 100;
    if (Number.isInteger(rounded)) return String(rounded);
    return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatBlended(pricing: Pricing | undefined): string | undefined {
    const blended = blendedRate(pricing);
    return blended === undefined ? undefined : formatRate(blended);
}

export function formatListed(pricing: Pricing | undefined): string | undefined {
    if (pricing === undefined) return undefined;
    if (pricing.input === 0 && pricing.output === 0) return "free";
    return `$${formatRate(pricing.input)} in, $${formatRate(pricing.output)} out`;
}

export function formatContext(tokens: number | undefined): string | undefined {
    if (tokens === undefined) return undefined;
    if (tokens >= 1_000_000) return `${formatRate(tokens / 1_000_000)}M`;
    return `${Math.round(tokens / 1000)}K`;
}

export function effortLabel(settings: ModelSettings, effort: string | undefined): string {
    if (effort === undefined) return "Default";
    const level = currentModel(settings)?.levels.find((entry) => entry.id === effort);
    return level?.label ?? capitalize(effort);
}

// The effort a model runs at when none is chosen.
export function defaultEffort(entry: ModelEntry | undefined): string | undefined {
    return entry?.defaultLevel;
}

function capitalize(text: string): string {
    return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1).replaceAll("_", " ");
}
