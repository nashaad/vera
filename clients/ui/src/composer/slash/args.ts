// Reads the text after /model, /effort and /permissions into a choice, or says there is none.
import { allModels, matchesQuery } from "../../models/catalog.ts";
import type { EffortLevel, ModelChoice, ModelEntry, ModelSettings } from "../../models/settings.ts";
import { modeOptions } from "../../session/permissions.ts";

export type ModelArgument =
    | { readonly kind: "pick"; readonly choice: ModelChoice }
    // Nothing matched on its own, so the model menu opens with this search.
    | { readonly kind: "search"; readonly query: string };

function same(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

// An exact id, "provider/id" or label wins; else the one model the words match; else a search.
export function resolveModelArgument(settings: ModelSettings, text: string): ModelArgument {
    const typed = text.trim();
    const available = allModels(settings).filter((entry) => entry.available);
    const exact = available.filter((entry) =>
        same(entry.model, typed) || same(`${entry.provider}/${entry.model}`, typed) || same(entry.label, typed));
    const candidates = exact.length > 0 ? exact : available.filter((entry) => matchesQuery(entry, typed));
    const [only] = candidates;
    if (only !== undefined && candidates.length === 1) return { kind: "pick", choice: choiceOf(only) };
    return { kind: "search", query: typed };
}

function choiceOf(entry: ModelEntry): ModelChoice {
    return { provider: entry.provider, model: entry.model };
}

export type EffortArgument =
    // `null` returns to the model's own default.
    | { readonly kind: "set"; readonly effort: string | null }
    | { readonly kind: "unknown"; readonly levels: readonly string[] };

export function resolveEffortArgument(levels: readonly EffortLevel[], text: string): EffortArgument {
    const typed = text.trim();
    if (same(typed, "default")) return { kind: "set", effort: null };
    const level = levels.find((candidate) => same(candidate.id, typed) || same(candidate.label, typed));
    return level === undefined ? { kind: "unknown", levels: levels.map((candidate) => candidate.id) } : { kind: "set", effort: level.id };
}

export type ModeArgument =
    | { readonly kind: "set"; readonly mode: string }
    | { readonly kind: "unknown"; readonly modes: readonly string[] };

export function resolveModeArgument(modes: readonly string[], text: string): ModeArgument {
    const typed = text.trim().replaceAll(" ", "_");
    const options = modeOptions(modes);
    const found = options.find((option) => same(option.mode, typed) || same(option.label, text.trim()));
    return found === undefined ? { kind: "unknown", modes: options.map((option) => option.mode) } : { kind: "set", mode: found.mode };
}
