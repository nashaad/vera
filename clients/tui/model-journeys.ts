import { halfPageCursor } from "./list-window.ts";
import { tuiBindingId } from "./keymap.ts";
import { passesIntelligenceCutoff, stepIntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import type { TuiSettingsPickerKey, TuiSettingsPickerOption, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

export function journeyMatches(state: TuiSettingsPickerState, revealAll = state.revealAll === true): readonly TuiSettingsPickerOption[] {
    const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return state.allOptions.filter((row) => (state.providerCatalogs === undefined || row.description !== "current model" || row.pooledRank !== undefined) && row.model !== undefined && row.provider !== undefined
        && (state.modelJourney === "shortlist" || state.tab === "all" || row.pooledRank !== undefined)
        && (state.modelJourney === "shortlist" || state.tab !== "all"
            || passesIntelligenceCutoff(row.waScore, state.intelligenceCutoff ?? "any"))
        && (revealAll || terms.length > 0 || row.hiddenByDefault === undefined || row.pooledRank !== undefined
            || state.modelJourney === "shortlist" && state.journeyRetainedModels?.includes(row.value))
        && terms.every((term) => `${row.label} ${row.provider} ${row.model}`.toLowerCase().includes(term)))
        .toSorted((a, b) => state.modelJourney === "shortlist"
            ? (a.provider ?? "").localeCompare(b.provider ?? "") || a.label.localeCompare(b.label)
            : 0);
}

function sectionKey(state: TuiSettingsPickerState, row: TuiSettingsPickerOption): string {
    const bucket = state.modelJourney === "shortlist" ? "shortlist" : state.tab;
    return `${bucket}:${row.provider}`;
}

export function journeyModels(state: TuiSettingsPickerState): readonly TuiSettingsPickerOption[] {
    const matches = journeyMatches(state);
    const groups = new Map<string, TuiSettingsPickerOption[]>();
    for (const row of matches) {
        const key = sectionKey(state, row);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }
    return [...groups.values()].flatMap((rows) => {
        const first = rows[0]!;
        const provider = state.providerCatalogs?.find((provider) => provider.id === first.provider)?.label ?? first.provider;
        return rows.map((row) => ({ ...row, group: `${provider}` }));
    });
}

export interface JourneyDisplayRow {
    readonly option?: TuiSettingsPickerOption;
    readonly heading?: string;
    readonly index: number;
}

export function journeyWindow(state: TuiSettingsPickerState, maxLines: number): readonly JourneyDisplayRow[] {
    const display: JourneyDisplayRow[] = state.options.flatMap((option, index) => [
        ...(index === 0 || option.group !== state.options[index - 1]?.group
            ? [...(index > 0 ? [{ index: -1 }] : []), { heading: option.group, index: -1 }] : []),
        { option, index },
    ]);
    const cursor = display.findIndex((row) => row.index === state.selectedIndex);
    const size = Math.max(1, maxLines - 1);
    const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), display.length - size));
    const visible = display.slice(start, start + size);
    while (visible[0]?.option === undefined && visible[0]?.heading === undefined && visible.length > 0) visible.shift();
    while (visible.at(-1)?.option === undefined && visible.length > 0) visible.pop();
    const first = visible[0];
    if (maxLines > 1 && first?.option !== undefined) {
        visible.unshift({ heading: first.option.group, index: -1 });
    }
    return visible;
}

function rebuiltJourney(state: TuiSettingsPickerState, selectedValue?: string): TuiSettingsPickerState {
    const options = journeyModels(state);
    const selected = options.findIndex((row) => row.value === selectedValue);
    return { ...state, options, selectedIndex: selected >= 0 ? selected : Math.max(0, options.findIndex((row) => row.model !== undefined)) };
}

export function modelJourney(state: TuiSettingsPickerState, mode: "switch" | "shortlist"): TuiSettingsPickerState {
    const next: TuiSettingsPickerState = { ...state,
        allOptions: state.providerCatalogs === undefined ? state.allOptions : state.allOptions.filter((row) => row.description !== "current model" || row.pooledRank !== undefined),
        modelJourney: mode,
        journeyRetainedModels: state.allOptions.filter((row) => row.pooledRank !== undefined).map((row) => row.value),
        title: mode === "switch" ? "Switch model" : "Model Library",
        tab: mode === "switch" ? "pool" : "all", modelFocus: "list", query: "", queryCursor: 0,
        selectedIndex: 0, pickerLevel: "page" };
    return rebuiltJourney({ ...next, collapsed: [] });
}

export function journeyHeader(state: TuiSettingsPickerState): string {
    if (state.modelJourney === "shortlist") return "";
    if (state.tab !== "all") return "";
    const description = "Models from your connected providers";
    const floor = state.intelligenceCutoff ?? "any";
    const hidden = state.allOptions.filter((row) => !passesIntelligenceCutoff(row.waScore, floor));
    const unscored = hidden.filter((row) => row.waScore === undefined).length;
    return description + (hidden.length ? `\n${hidden.length} hidden below the cutoff, including ${unscored} unscored models.` : "");
}

export function journeyFooter(state: TuiSettingsPickerState): string {
    const selected = state.options[state.selectedIndex];
    const action = selected === undefined ? "Select a model"
        : selected.pooledRank === undefined ? "Add to library" : "Remove from library";
    const reveal = state.revealAll ? "Hide extra variants and older models" : "Show extra variants and older models";
    return state.modelJourney === "shortlist"
        ? `Enter / Ctrl+S  ${action}\nCtrl+A  ${reveal}\nCtrl+R Rename · Ctrl+Y Verify · Esc Back`
        : `${state.tab === "all" ? `Ctrl+A  ${reveal}` : ""}\n↑↓ choose · ↵ switch model · esc back`;
}

export function handleModelJourneyKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey, viewportRows = 12): TuiSettingsPickerTransition {
    const same = { state, handled: true };
    const selected = state.options[state.selectedIndex];
    const managing = state.modelJourney === "shortlist";
    const paging = tuiBindingId("picker", key);
    if (paging === "half_page_down" || paging === "half_page_up") return {
        handled: true, state: { ...state, modelFocus: "list",
            selectedIndex: halfPageCursor(state.selectedIndex, state.options.length, Math.min(12, viewportRows),
                paging === "half_page_down" ? "down" : "up") },
    };
    if (tuiBindingId("model_picker", key) === "toggle_pooled") {
        if (!managing) return same;
        return selected?.provider && selected.model ? { ...same,
            poolToggle: { action: selected.pooledRank === undefined ? "add" : "remove",
                provider: selected.provider, model: selected.model } } : same;
    }
    const binding = tuiBindingId(managing ? "shortlist_picker" : "switch_model_picker", key);
    if (key.name === "escape" || key.name === "esc") return { state: state.parent, handled: true };
    if (!managing && state.tab === "all" && state.modelFocus === "intelligence" && !key.ctrl) {
        if (key.name === "left" || key.name === "right") return { state: rebuiltJourney({ ...state,
            intelligenceCutoff: stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", key.name === "left" ? -1 : 1),
        }, selected?.value), handled: true };
        if (key.name === "down" || key.name === "enter" || key.name === "return") return { state: { ...state, modelFocus: "list" }, handled: true };
        if (key.name === "up") return same;
    }
    if (!managing && state.tab === "all" && key.name === "up" && state.selectedIndex === 0) {
        return { state: { ...state, modelFocus: "intelligence" }, handled: true };
    }
    if (!managing && state.tab === "all" && key.name === "left" && !key.ctrl) {
        return { state: { ...state, modelFocus: "intelligence" }, handled: true };
    }
    if (key.name === "left" || key.name === "right") return same;
    if (tuiBindingId("switch_model_picker", key) === "journey_scope") {
        if (managing) return same;
        const next = { ...state, tab: state.tab === "all" ? "pool" as const : "all" as const, modelFocus: "list" as const, selectedIndex: 0 };
        return { state: rebuiltJourney(next), handled: true };
    }
    if (binding !== undefined || key.ctrl) {
        if (binding === "journey_reveal" || binding === "shortlist_reveal") return { state: rebuiltJourney({ ...state, revealAll: state.revealAll !== true }, selected?.value), handled: true };
        if (binding === "shortlist_providers") return { ...same, openProviders: true };
        if (binding === "journey_refresh") return { ...same, refreshAllCatalogs: true };
        if (binding === "journey_cutoff" && state.tab === "all") {
            const next = { ...state, intelligenceCutoff: state.intelligenceCutoff === "1600" && !key.shift ? "any" as const : stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", key.shift ? -1 : 1), selectedIndex: 0 };
            return { state: rebuiltJourney(next), handled: true };
        }
        if (managing && selected?.provider && selected.model) {
            if (binding === "shortlist_rename") return { ...same, poolName: { provider: selected.provider, model: selected.model, label: selected.label } };
            if (binding === "shortlist_verify") return selected.pooledRank === undefined
                ? { handled: true, state: { ...state, journeyFeedback: { status: "error", message: `Add ${selected.label} to your library before verifying it.` } } }
                : { ...same, poolVerify: { provider: selected.provider, model: selected.model } };
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
    if (state.modelJourney === "switch" && state.tab !== "all") return "Your library is empty. Browse Catalog to choose one.";
    return "No models pass this cutoff. ^g changes the cutoff.";
}
