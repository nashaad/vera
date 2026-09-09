import { halfPageCursor } from "./list-window.ts";
import { tuiBindingId } from "./keymap.ts";
import { passesIntelligenceCutoff, stepIntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import type { ModelJourneySection, TuiSettingsPickerKey, TuiSettingsPickerOption, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

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
    const navigation = state.modelFocus === "scope" ? "⏎ choose which models to show"
        : state.modelFocus === "search" ? "Type to search · ←→ move cursor"
        : state.modelFocus === "intelligence" ? "←→ change cutoff"
        : state.modelFocus === "more" ? "⏎ open More"
        : "↑↓ choose · ⏎ switch model";
    return state.modelJourney === "shortlist"
        ? `⏎ / Ctrl+S  ${action}\nCtrl+A  ${reveal}\nCtrl+R Rename · Ctrl+Y Verify · Esc Back`
        : `${state.modelFocus === "more" ? "›" : " "} Ctrl+K More: ${state.tab === "all" ? "variants, refresh" : "refresh"}\n${navigation}\nTab / Shift+Tab sections · Esc back`;
}

export function journeySections(state: TuiSettingsPickerState): readonly ModelJourneySection[] {
    return ["scope", "search", ...(state.tab === "all" ? ["intelligence" as const] : []), "list", "more"];
}

export function journeyScopeOptions(state: TuiSettingsPickerState): readonly TuiSettingsPickerOption[] {
    const counts = { ...state, query: "", intelligenceCutoff: "any" as const };
    return [
        { value: "scope:pool", label: `Library models (${state.allOptions.filter((row) => row.pooledRank !== undefined).length})`, description: "" },
        { value: "scope:all", label: `Provider catalog (${journeyMatches({ ...counts, tab: "all" }).filter((row) => !row.unavailable).length})`, description: "" },
    ];
}

export function modelJourneyScope(parent: TuiSettingsPickerState): TuiSettingsPickerState {
    const options = journeyScopeOptions(parent);
    return { kind: "model_menu", title: "Show models", options, allOptions: options,
        selectedIndex: parent.tab === "all" ? 1 : 0, query: "", parent };
}

export function modelJourneyMenu(parent: TuiSettingsPickerState): TuiSettingsPickerState {
    const options: TuiSettingsPickerOption[] = [
        ...(parent.tab === "all" ? [{ value: "variants", label: parent.revealAll
            ? "Hide extra variants and older models" : "Show extra variants and older models", description: "" }] : []),
        { value: "refresh", label: "Refresh model catalog", description: "" },
    ];
    return { kind: "model_menu", title: "More", options, allOptions: options,
        selectedIndex: 0, query: "", parent };
}

export function handleModelJourneyMenuKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey): TuiSettingsPickerTransition {
    const parent = state.parent;
    if (key.name === "escape" || key.name === "esc" || (state.title === "More" && tuiBindingId("switch_model_picker", key) === "journey_more")) {
        return { state: parent, handled: true };
    }
    if (key.name === "up" || key.name === "down") return { handled: true, state: { ...state,
        selectedIndex: Math.max(0, Math.min(state.options.length - 1, state.selectedIndex + (key.name === "up" ? -1 : 1))) } };
    if ((key.name === "enter" || key.name === "return") && parent?.kind === "model") {
        const value = state.options[state.selectedIndex]?.value;
        if (value === "scope:pool" || value === "scope:all") return {
            state: rebuiltJourney({ ...parent, modelFocus: "list", tab: value === "scope:all" ? "all" : "pool" }, parent.options[parent.selectedIndex]?.value), handled: true,
        };
        if (state.options[state.selectedIndex]?.value === "variants") return {
            state: rebuiltJourney({ ...parent, revealAll: parent.revealAll !== true }, parent.options[parent.selectedIndex]?.value), handled: true,
        };
        if (state.options[state.selectedIndex]?.value === "refresh") return { state: parent, handled: true, refreshAllCatalogs: true };
    }
    return { state, handled: true };
}

export function handleModelJourneyKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey, viewportRows = 12): TuiSettingsPickerTransition {
    const same = { state, handled: true };
    const selected = state.options[state.selectedIndex];
    const managing = state.modelJourney === "shortlist";
    if (!managing && tuiBindingId("switch_model_picker", key) === "journey_section") {
        const sections = journeySections(state);
        const at = sections.indexOf((state.modelFocus ?? "list") as ModelJourneySection);
        const delta = key.shift || key.name === "backtab" ? -1 : 1;
        return { state: { ...state, modelFocus: sections[(at + delta + sections.length) % sections.length]! }, handled: true };
    }
    const paging = tuiBindingId("picker", key);
    if ((managing || state.modelFocus === "list") && (paging === "half_page_down" || paging === "half_page_up")) return {
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
    if (binding === "journey_more") return { state: modelJourneyMenu(state), handled: true };
    if (key.name === "escape" || key.name === "esc") return { state: state.parent, handled: true };
    if (!managing && state.tab === "all" && state.modelFocus === "intelligence" && !key.ctrl) {
        if (key.name === "left" || key.name === "right") return { state: rebuiltJourney({ ...state,
            intelligenceCutoff: stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", key.name === "left" ? -1 : 1),
        }, selected?.value), handled: true };
        if (key.name === "up") return same;
    }
    if (key.name === "left" || key.name === "right") return same;
    if (binding !== undefined || key.ctrl) {
        if (binding === "journey_reveal" || binding === "shortlist_reveal") return { state: rebuiltJourney({ ...state, revealAll: state.revealAll !== true }, selected?.value), handled: true };
        if (binding === "shortlist_providers") return { ...same, openProviders: true };
        if (binding === "journey_refresh") return { ...same, refreshAllCatalogs: true };
        if (binding === "journey_cutoff" && state.tab === "all") {
            const next = { ...state, intelligenceCutoff: state.intelligenceCutoff === "1600" && !key.shift ? "any" as const : stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", key.shift ? -1 : 1) };
            return { state: rebuiltJourney(next, selected?.value), handled: true };
        }
        if (managing && selected?.provider && selected.model) {
            if (binding === "shortlist_rename") return { ...same, poolName: { provider: selected.provider, model: selected.model, label: selected.label } };
            if (binding === "shortlist_verify") return selected.pooledRank === undefined
                ? { handled: true, state: { ...state, journeyFeedback: { status: "error", message: `Add ${selected.label} to your library before verifying it.` } } }
                : { ...same, poolVerify: { provider: selected.provider, model: selected.model } };
        }
        return same;
    }
    if (!managing && state.modelFocus !== "list") {
        if (key.name === "enter" || key.name === "return") {
            if (state.modelFocus === "scope") return { state: modelJourneyScope(state), handled: true };
            if (state.modelFocus === "more") return { state: modelJourneyMenu(state), handled: true };
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
