import { passesIntelligenceCutoff, stepIntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import type { TuiSettingsPickerKey, TuiSettingsPickerOption, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

export function journeyModels(state: TuiSettingsPickerState): readonly TuiSettingsPickerOption[] {
    const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return state.allOptions.filter((row) => (state.providerCatalogs === undefined || row.description !== "current model" || row.pooledRank !== undefined) && row.model !== undefined && row.provider !== undefined
        && (state.modelJourney === "shortlist" || state.tab === "all" || row.pooledRank !== undefined)
        && (state.modelJourney === "shortlist" || state.tab !== "all"
            || passesIntelligenceCutoff(row.waScore, state.intelligenceCutoff ?? "any"))
        && terms.every((term) => `${row.label} ${row.provider} ${row.model}`.toLowerCase().includes(term)))
        .toSorted((a, b) => state.modelJourney === "shortlist"
            ? Number(b.pooledRank !== undefined) - Number(a.pooledRank !== undefined)
                || a.label.localeCompare(b.label)
            : 0);
}

export function modelJourney(state: TuiSettingsPickerState, mode: "switch" | "shortlist"): TuiSettingsPickerState {
    const next: TuiSettingsPickerState = { ...state,
        allOptions: state.providerCatalogs === undefined ? state.allOptions : state.allOptions.filter((row) => row.description !== "current model" || row.pooledRank !== undefined),
        modelJourney: mode,
        title: mode === "switch" ? "Switch model" : "Manage shortlist",
        tab: mode === "switch" ? "pool" : "all", modelFocus: "list", query: "", queryCursor: 0,
        selectedIndex: 0, pickerLevel: "page" };
    return { ...next, options: journeyModels(next) };
}

export function journeyHeader(state: TuiSettingsPickerState): string {
    if (state.modelJourney === "shortlist") {
        const kept = state.allOptions.filter((row) => row.pooledRank !== undefined);
        const verified = kept.filter((row) => row.unverified !== true).length;
        return `${kept.length} kept of ${state.allOptions.length} discovered · ${verified} verified\n`
            + `A default slot only accepts a verified model; ${kept.length - verified} cannot hold one yet.`;
    }
    const scope = state.tab === "all" ? "shortlist [all]" : "[shortlist] all";
    if (state.tab !== "all") return `Scope: ${scope} · tab scope`;
    const floor = state.intelligenceCutoff ?? "any";
    const cutoff = ["any", "1400", "1450", "1500", "1550", "1600"].map((value) => value === floor ? `[${value}]` : value).join(" ");
    const hidden = state.allOptions.filter((row) => !passesIntelligenceCutoff(row.waScore, floor));
    const unscored = hidden.filter((row) => row.waScore === undefined).length;
    return `Scope: ${scope} · tab scope    Cutoff: ${cutoff} · ^i cutoff\n`
        + (hidden.length ? `${hidden.length} hidden below the cutoff, including ${unscored} unscored models.` : "");
}

export function journeyFooter(state: TuiSettingsPickerState): string {
    return state.modelJourney === "shortlist"
        ? "↵ keep or unkeep · ^r rename · ^y verify · ^k keep matches · ^u unkeep matches · esc done"
        : "↵ run it · tab scope · ^r refresh catalogs · ^s manage shortlist · ^e providers · esc";
}

export function handleModelJourneyKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey): TuiSettingsPickerTransition {
    const same = { state, handled: true };
    const selected = state.options[state.selectedIndex];
    const managing = state.modelJourney === "shortlist";
    if (key.name === "escape" || key.name === "esc") return { state: state.parent, handled: true };
    if (key.name === "tab") {
        if (managing) return same;
        const next = { ...state, tab: state.tab === "all" ? "pool" as const : "all" as const, selectedIndex: 0 };
        return { state: { ...next, options: journeyModels(next) }, handled: true };
    }
    if (key.ctrl) {
        if (key.name === "e") return { ...same, openProviders: true };
        if (!managing && key.name === "s") return { state: modelJourney(state, "shortlist"), handled: true };
        if (!managing && key.name === "r") return { ...same, refreshAllCatalogs: true };
        if (!managing && key.name === "i" && state.tab === "all") {
            const next = { ...state, intelligenceCutoff: state.intelligenceCutoff === "1600" && !key.shift ? "any" as const : stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", key.shift ? -1 : 1), selectedIndex: 0 };
            return { state: { ...next, options: journeyModels(next) }, handled: true };
        }
        if (managing && (key.name === "k" || key.name === "u")) return { ...same,
            poolBulk: { action: key.name === "k" ? "add" : "remove", models: state.options.filter((row) =>
                key.name === "k" ? row.pooledRank === undefined : row.pooledRank !== undefined) } };
        if (managing && selected?.provider && selected.model) {
            if (key.name === "r") return { ...same, poolName: { provider: selected.provider, model: selected.model, label: selected.label } };
            if (key.name === "y") return { ...same, poolVerify: { provider: selected.provider, model: selected.model } };
        }
        return same;
    }
    if (key.name === "up" || key.name === "down") return { handled: true, state: { ...state,
        selectedIndex: Math.max(0, Math.min(state.options.length - 1, state.selectedIndex + (key.name === "up" ? -1 : 1))) } };
    if ((key.name === "enter" || key.name === "return") && selected?.provider && selected.model) {
        if (selected.unavailable && !managing) return same;
        if (managing) return { ...same, poolToggle: { action: selected.pooledRank === undefined ? "add" : "remove",
            provider: selected.provider, model: selected.model } };
        return { handled: true, selection: { kind: "model", provider: selected.provider, model: selected.model } };
    }
    return { state, handled: false };
}

export function emptyModelJourney(state: TuiSettingsPickerState): string {
    if (state.providerCatalogs?.length === 0) return "No provider connected. ^e opens Configure providers.";
    const never = state.providerCatalogs?.filter((provider) => provider.refreshedAt === undefined) ?? [];
    if (state.allOptions.length === 0 && never.length) return `${never.map((provider) => provider.label).join(", ")}: catalog never refreshed. ^r reads it now.`;
    if (state.allOptions.length === 0) return "All provider catalogs were refreshed; none served any models. ^e opens Configure providers.";
    if (state.query) return "No models match your search. Clear the search to see models.";
    if (state.modelJourney === "switch" && state.tab !== "all") return "Your shortlist is empty. Tab shows all models; ^s opens Manage shortlist.";
    return "No models pass this cutoff. ^i changes the cutoff.";
}
