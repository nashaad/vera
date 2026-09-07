import { tuiBindingId } from "./keymap.ts";
import { passesIntelligenceCutoff, stepIntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import type { TuiSettingsPickerKey, TuiSettingsPickerOption, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

export function journeyMatches(state: TuiSettingsPickerState, revealAll = state.revealAll === true): readonly TuiSettingsPickerOption[] {
    const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return state.allOptions.filter((row) => (state.providerCatalogs === undefined || row.description !== "current model" || row.pooledRank !== undefined) && row.model !== undefined && row.provider !== undefined
        && (state.modelJourney === "shortlist" || state.tab === "all" || row.pooledRank !== undefined)
        && (state.modelJourney === "shortlist" || state.tab !== "all"
            || passesIntelligenceCutoff(row.waScore, state.intelligenceCutoff ?? "any"))
        && (revealAll || terms.length > 0 || row.hiddenByDefault === undefined || row.pooledRank !== undefined)
        && terms.every((term) => `${row.label} ${row.provider} ${row.model}`.toLowerCase().includes(term)))
        .toSorted((a, b) => state.modelJourney === "shortlist"
            ? Number(b.pooledRank !== undefined) - Number(a.pooledRank !== undefined)
                || a.label.localeCompare(b.label)
            : 0);
}

function sectionKey(state: TuiSettingsPickerState, row: TuiSettingsPickerOption): string {
    const bucket = state.modelJourney === "shortlist" ? (row.pooledRank === undefined ? "available" : "kept") : state.tab;
    return `${bucket}:${row.provider}`;
}

export function journeyModels(state: TuiSettingsPickerState): readonly TuiSettingsPickerOption[] {
    const matches = journeyMatches(state);
    const totals = new Map<string, number>();
    for (const row of journeyMatches(state, true)) {
        const key = sectionKey(state, row);
        totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const groups = new Map<string, TuiSettingsPickerOption[]>();
    for (const row of matches) {
        const key = sectionKey(state, row);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }
    return [...groups].flatMap(([key, rows]) => {
        const first = rows[0]!;
        const provider = state.providerCatalogs?.find((provider) => provider.id === first.provider)?.label ?? first.group ?? first.provider;
        const total = totals.get(key) ?? rows.length;
        const count = rows.length === total ? `${total}` : `${rows.length} of ${total}`;
        const kept = state.modelJourney === "shortlist" && first.pooledRank !== undefined ? "Kept · " : "";
        const closed = state.query.trim() === "" && state.collapsed?.includes(key) === true;
        const header: TuiSettingsPickerOption = { value: `section:${key}`, section: key,
            label: `${kept}${provider} (${count})`, description: "", sectionCollapsed: closed };
        return closed ? [header] : [header, ...rows];
    });
}

export interface JourneyDisplayRow {
    readonly option?: TuiSettingsPickerOption;
    readonly index: number;
}

export function journeyWindow(state: TuiSettingsPickerState, maxLines: number): readonly JourneyDisplayRow[] {
    const display = state.options.flatMap((option, index) => [
        ...(option.section !== undefined && index > 0 ? [{ index: -1 }] : []),
        { option, index },
    ]);
    const cursor = display.findIndex((row) => row.index === state.selectedIndex);
    const size = Math.max(1, maxLines - 1);
    const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), display.length - size));
    const visible = display.slice(start, start + size);
    while (visible[0]?.option === undefined && visible.length > 0) visible.shift();
    while (visible.at(-1)?.option === undefined && visible.length > 0) visible.pop();
    const first = visible[0];
    if (maxLines > 1 && first !== undefined && first.option?.section === undefined) {
        const parent = state.options.slice(0, first.index).findLastIndex((row) => row.section !== undefined);
        if (parent >= 0) visible.unshift({ option: state.options[parent], index: parent });
    }
    return visible;
}

function rebuiltJourney(state: TuiSettingsPickerState, selectedValue?: string): TuiSettingsPickerState {
    const options = journeyModels(state);
    const selected = options.findIndex((row) => row.value === selectedValue);
    return { ...state, options, selectedIndex: selected >= 0 ? selected : Math.max(0, options.findIndex((row) => row.model !== undefined)) };
}

function foldJourney(state: TuiSettingsPickerState, close?: boolean, all = false): TuiSettingsPickerState {
    if (state.query.trim() !== "") return state;
    const section = state.options.slice(0, state.selectedIndex + 1).findLast((row) => row.section !== undefined);
    if (section?.section === undefined) return state;
    const keys = all ? journeyModels({ ...state, collapsed: [] }).flatMap((row) => row.section === undefined ? [] : [row.section]) : [section.section];
    const closing = close ?? !section.sectionCollapsed;
    const collapsed = new Set(state.collapsed ?? []);
    for (const key of keys) { if (closing) collapsed.add(key); else collapsed.delete(key); }
    return rebuiltJourney({ ...state, collapsed: [...collapsed] }, section.value);
}

export function modelJourney(state: TuiSettingsPickerState, mode: "switch" | "shortlist"): TuiSettingsPickerState {
    const next: TuiSettingsPickerState = { ...state,
        allOptions: state.providerCatalogs === undefined ? state.allOptions : state.allOptions.filter((row) => row.description !== "current model" || row.pooledRank !== undefined),
        modelJourney: mode,
        title: mode === "switch" ? "Switch model" : "Manage shortlist",
        tab: mode === "switch" ? "pool" : "all", modelFocus: "list", query: "", queryCursor: 0,
        selectedIndex: 0, pickerLevel: "page" };
    const counts = new Map<string, number>();
    for (const row of journeyMatches({ ...next, tab: "all" })) {
        const key = sectionKey({ ...next, tab: "all" }, row);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const current = next.allOptions.find((row) => row.value === next.initialModel);
    const open = current === undefined ? undefined : sectionKey({ ...next, tab: "all" }, current);
    return rebuiltJourney({ ...next, collapsed: [...counts].filter(([key, count]) => count > 8 && key !== open && !key.startsWith("kept:")).map(([key]) => key) });
}

export function journeyHeader(state: TuiSettingsPickerState): string {
    const hiddenCount = journeyMatches(state, true).length - journeyMatches(state, false).length;
    const reduced = hiddenCount > 0 ? `\n${hiddenCount} older, duplicate or superseded models ${state.revealAll ? "included" : "hidden"} · ^a ${state.revealAll ? "show fewer" : "show all"}` : "";
    if (state.modelJourney === "shortlist") {
        const kept = state.allOptions.filter((row) => row.pooledRank !== undefined);
        const verified = kept.filter((row) => row.unverified !== true).length;
        const unavailable = kept.filter((row) => row.unavailable).length;
        const discovered = state.allOptions.filter((row) => !row.unavailable).length;
        return `${kept.length} kept of ${discovered} discovered · ${verified} verified${unavailable ? ` · ${unavailable} kept unavailable` : ""}\n`
            + `A default slot only accepts a verified model; ${kept.length - verified} cannot hold one yet.${reduced}`;
    }
    const scope = state.tab === "all" ? "shortlist [all]" : "[shortlist] all";
    if (state.tab !== "all") return `Scope: ${scope} · tab scope`;
    const floor = state.intelligenceCutoff ?? "any";
    const hidden = state.allOptions.filter((row) => !passesIntelligenceCutoff(row.waScore, floor));
    const unscored = hidden.filter((row) => row.waScore === undefined).length;
    return `Scope: ${scope} · tab scope    Intelligence cutoff · ^g step · ↑ from the first row to adjust\n`
        + (hidden.length ? `${hidden.length} hidden below the cutoff, including ${unscored} unscored models.` : "") + reduced;
}

export function journeyFooter(state: TuiSettingsPickerState): string {
    return state.modelJourney === "shortlist"
        ? "↵ keep or unkeep · ^r rename · ^y verify · ^k keep matches · ^u unkeep matches · esc done\n←/→ fold provider · ⇧←/→ fold all · ^a show all/fewer"
        : "↵ run it · tab scope · ^r refresh catalogs · ^s manage shortlist · ^e providers · esc\n←/→ fold provider · ⇧←/→ fold all · ^a show all/fewer";
}

export function handleModelJourneyKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey): TuiSettingsPickerTransition {
    const same = { state, handled: true };
    const selected = state.options[state.selectedIndex];
    const managing = state.modelJourney === "shortlist";
    const binding = tuiBindingId(managing ? "shortlist_picker" : "switch_model_picker", key);
    if (key.name === "escape" || key.name === "esc") return { state: state.parent, handled: true };
    if (!managing && state.tab === "all" && state.modelFocus === "intelligence" && !key.ctrl) {
        if (key.name === "left" || key.name === "right") return { state: rebuiltJourney({ ...state,
            intelligenceCutoff: stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", key.name === "left" ? -1 : 1),
        }), handled: true };
        if (key.name === "down" || key.name === "enter" || key.name === "return") return { state: { ...state, modelFocus: "list" }, handled: true };
        if (key.name === "up") return same;
    }
    if (!managing && state.tab === "all" && key.name === "up" && state.selectedIndex === 0) {
        return { state: { ...state, modelFocus: "intelligence" }, handled: true };
    }
    if (key.name === "left" || key.name === "right") {
        return { state: foldJourney(state, key.name === "left", key.shift === true), handled: true };
    }
    if ((key.name === "enter" || key.name === "return") && selected?.section !== undefined) {
        return { state: foldJourney(state), handled: true };
    }
    if (tuiBindingId("switch_model_picker", key) === "journey_scope") {
        if (managing) return same;
        const next = { ...state, tab: state.tab === "all" ? "pool" as const : "all" as const, modelFocus: "list" as const, selectedIndex: 0 };
        return { state: rebuiltJourney(next), handled: true };
    }
    if (binding !== undefined || key.ctrl) {
        if (binding === "journey_reveal" || binding === "shortlist_reveal") return { state: rebuiltJourney({ ...state, revealAll: state.revealAll !== true }, selected?.value), handled: true };
        if (binding === "journey_providers" || binding === "shortlist_providers") return { ...same, openProviders: true };
        if (binding === "journey_manage") return { state: modelJourney(state, "shortlist"), handled: true };
        if (binding === "journey_refresh") return { ...same, refreshAllCatalogs: true };
        if (binding === "journey_cutoff" && state.tab === "all") {
            const next = { ...state, intelligenceCutoff: state.intelligenceCutoff === "1600" && !key.shift ? "any" as const : stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", key.shift ? -1 : 1), selectedIndex: 0 };
            return { state: rebuiltJourney(next), handled: true };
        }
        if (binding === "shortlist_keep_matches" || binding === "shortlist_unkeep_matches") return { ...same,
            poolBulk: { action: binding === "shortlist_keep_matches" ? "add" : "remove", models: journeyMatches(state).filter((row) =>
                binding === "shortlist_keep_matches" ? row.pooledRank === undefined : row.pooledRank !== undefined) } };
        if (managing && selected?.provider && selected.model) {
            if (binding === "shortlist_rename") return { ...same, poolName: { provider: selected.provider, model: selected.model, label: selected.label } };
            if (binding === "shortlist_verify") return { ...same, poolVerify: { provider: selected.provider, model: selected.model } };
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
    return "No models pass this cutoff. ^g changes the cutoff.";
}
