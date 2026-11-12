import type { ProbeOutcome } from "../controls.ts";
import { allModels, effortLabel, formatBlended, formatContext, formatListed, modelName, sameModel } from "../catalog.ts";
import type { ModelChoice, ModelEntry, ModelSettings } from "../settings.ts";

export type BrowserTab = "Favorites" | "All models" | "Defaults" | "Help";

export const BROWSER_TABS: readonly BrowserTab[] = ["Favorites", "All models", "Defaults", "Help"];

export const TAB_NOTES: Record<BrowserTab, string> = {
    Favorites: "The models the composer offers first",
    "All models": "Every model your connected providers list",
    Defaults: "The model and effort each job starts with",
    Help: "What the marks in these tabs mean",
};

export interface FactRow {
    readonly label: string;
    readonly value: string;
    readonly good?: boolean;
    readonly mono?: boolean;
}

export interface DefaultRow {
    readonly label: string;
    readonly value: string;
    readonly note?: string;
}

const NOT_LISTED = "Not listed";

export function entryKey(entry: { readonly provider: string; readonly model: string }): string {
    return `${entry.provider}/${entry.model}`;
}

export function modelId(ref: { readonly provider?: string; readonly model: string }): string {
    return ref.provider === undefined ? ref.model : `${ref.provider}/${ref.model}`;
}

export function tabRows(tab: BrowserTab, settings: ModelSettings): readonly ModelEntry[] {
    return tab === "Favorites" ? settings.shortlist : allModels(settings);
}

export const ANY_PROVIDER = "any";

// Connections, the one listing the most models first.
export function providerOrder(settings: ModelSettings): readonly string[] {
    const counts = new Map<string, number>();
    for (const entry of allModels(settings)) counts.set(entry.provider, (counts.get(entry.provider) ?? 0) + 1);
    return [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}

export function fromProvider(rows: readonly ModelEntry[], provider: string): readonly ModelEntry[] {
    return provider === ANY_PROVIDER ? rows : rows.filter((entry) => entry.provider === provider);
}

export function cutoffLabel(cutoff: string): string {
    return cutoff === "any" ? "Any" : `${cutoff}+`;
}

export function isCurrent(entry: ModelEntry, choice: ModelChoice | undefined): boolean {
    return choice !== undefined && sameModel(entry, choice);
}

// Keeps the chosen row while it is still listed, otherwise the current model, otherwise the first row.
export function pickSelection(
    rows: readonly ModelEntry[],
    selectedKey: string | undefined,
    choice: ModelChoice | undefined,
): ModelEntry | undefined {
    return rows.find((entry) => entryKey(entry) === selectedKey)
        ?? rows.find((entry) => isCurrent(entry, choice))
        ?? rows[0];
}

export function waText(entry: ModelEntry): string {
    return entry.waScore === undefined ? "-" : String(entry.waScore);
}

export function blendedText(entry: ModelEntry): string {
    return formatBlended(entry.pricing) ?? "-";
}

export function modelFacts(entry: ModelEntry, pinned: boolean): readonly FactRow[] {
    const blended = formatBlended(entry.pricing);
    return [
        { label: "Favorite", value: pinned ? "Yes" : "No", good: pinned },
        { label: "Verified", value: entry.verified ? "Yes" : (entry.verificationError ?? "No"), good: entry.verified },
        { label: "Images", value: yesNoUnknown(entry.imageSupport) },
        { label: "WA score", value: entry.waScore === undefined ? NOT_LISTED : String(entry.waScore) },
        { label: "Listed price", value: formatListed(entry.pricing) ?? NOT_LISTED },
        {
            label: "Blended price",
            value: blended === undefined ? NOT_LISTED : `$${blended} per M, 3:1 in:out`,
        },
        {
            label: "Front",
            value: entry.onPareto ? "Yes, best score for its price" : "No",
            good: entry.onPareto,
        },
        { label: "Context", value: formatContext(entry.contextWindow) ?? NOT_LISTED },
        { label: "Model ID", value: modelId(entry), mono: true },
    ];
}

export function defaultRows(settings: ModelSettings): readonly DefaultRow[] {
    const name = modelName(settings, settings);
    const session = settings.effort === undefined
        ? name
        : `${name}, ${effortLabel(settings, settings.effort)} effort`;
    return [
        {
            label: "New sessions",
            value: session,
            note: "Choosing a model in a session also makes it the default for new sessions.",
        },
        { label: "Subagents", value: subagentValue(settings) },
        { label: "Reviewer", value: reviewerValue(settings) },
    ];
}

export function probeLine(outcome: ProbeOutcome): string {
    return outcome.ok ? "Probe passed." : `Probe failed: ${outcome.reason}`;
}

function yesNoUnknown(value: boolean | undefined): string {
    if (value === undefined) return "Unknown";
    return value ? "Yes" : "No";
}

function subagentValue(settings: ModelSettings): string {
    const subagent = settings.subagentDefault;
    if (subagent === undefined) return "Not reported";
    if (subagent.mode === "inherit") return "Same as the parent session";
    if (subagent.mode === "none") return "None assigned";
    return subagent.choice === undefined ? "Not set" : modelName(settings, subagent.choice);
}

function reviewerValue(settings: ModelSettings): string {
    const reviewer = settings.reviewerDefault;
    if (reviewer === undefined) return "Not reported";
    if (reviewer.mode === "agent") return "Chosen per review";
    const primary = reviewer.primary === undefined ? "Not set" : modelName(settings, reviewer.primary);
    const fallback = reviewer.fallback === undefined ? "none" : modelName(settings, reviewer.fallback);
    return `Primary ${primary}, fallback ${fallback}`;
}
