import { halfPageCursor } from "./list-window.ts";
import { sectionHeader } from "./settings-picker-model.ts";
import { tuiBindingId } from "./keymap.ts";
import { passesIntelligenceCutoff, stepIntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import { blendedRate } from "../../src/model/listed-rates.ts";
import type { ModelJourneySection, ModelJourneySort, TuiSettingsPickerKey, TuiSettingsPickerOption, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

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

/** Library order exists only in Library models; Provider catalog falls back to A to Z. */
export function journeySort(state: TuiSettingsPickerState): ModelJourneySort {
    const sort = state.journeySort ?? (state.tab === "all" ? "az" : "library");
    return sort === "library" && state.tab === "all" ? "az" : sort;
}

function sortedWithinGroup(state: TuiSettingsPickerState, rows: readonly TuiSettingsPickerOption[]): readonly TuiSettingsPickerOption[] {
    const sort = state.modelJourney === "switch" ? journeySort(state) : "library";
    if (sort === "library") return rows;
    return rows.toSorted((a, b) => {
        if (sort === "price") {
            const left = blendedRate(a.pricing), right = blendedRate(b.pricing);
            if (left !== right) return left === undefined ? 1 : right === undefined ? -1 : left - right;
        }
        return a.label.localeCompare(b.label);
    });
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
    const collapsed = state.collapsed ?? [];
    return [...groups.values()].flatMap((members) => {
        const rows = sortedWithinGroup(state, members);
        const first = rows[0]!;
        const provider = state.providerCatalogs?.find((provider) => provider.id === first.provider)?.label ?? first.provider;
        const group = `${provider}`;
        return collapsed.includes(group)
            ? [{ ...sectionHeader(group, rows, collapsed), group }]
            : rows.map((row) => ({ ...row, group }));
    });
}

export interface JourneyDisplayRow {
    readonly option?: TuiSettingsPickerOption;
    readonly heading?: string;
    readonly more?: { readonly above: number; readonly below: number };
    readonly index: number;
}

export interface JourneyWindow {
    readonly rows: readonly JourneyDisplayRow[];
    /** The display line at the top of the window; pass it back on the next render so the list only moves when the cursor leaves it. */
    readonly top: number;
}

/** Every call shows the same number of lines, so one cursor step moves the list by at most one line. */
export function journeyWindow(state: TuiSettingsPickerState, maxLines: number, previousTop = 0): JourneyWindow {
    const display: JourneyDisplayRow[] = state.options.flatMap((option, index) => [
        ...((index === 0 || option.group !== state.options[index - 1]?.group) && option.section === undefined
            ? [{ heading: option.group, index: -1 }] : []),
        { option, index },
    ]);
    if (display.length <= maxLines) return { rows: display, top: 0 };
    // The bottom lines are a gap and the count of models outside the window.
    const size = Math.max(1, maxLines - (maxLines > 2 ? 2 : 1));
    const cursor = Math.max(0, display.findIndex((row) => row.index === state.selectedIndex));
    // A model row on the top line gives way to its group heading, unless it is the group's last row.
    const pinned = (at: number) => size > 1 && display[at]?.option !== undefined && display[at]?.option?.section === undefined
        && display[at + 1]?.heading === undefined;
    let top = Math.min(previousTop, display.length - size);
    if (cursor < top || (cursor === top && pinned(top))) top = pinned(cursor) ? cursor - 1 : cursor;
    if (cursor > top + size - 1) top = cursor - size + 1;
    top = Math.max(0, Math.min(top, display.length - size));
    const visible = display.slice(top, top + size);
    if (pinned(top)) visible[0] = { heading: visible[0]!.option!.group, index: -1 };
    const shown = visible.flatMap((row) => row.option === undefined ? [] : [row.index]);
    if (maxLines < 2 || shown.length === 0) return { rows: visible, top };
    const models = (from: number, to: number) => state.options.slice(from, to).filter((row) => row.section === undefined).length;
    const above = models(0, Math.min(...shown));
    const below = models(Math.max(...shown) + 1, state.options.length);
    if (maxLines > 2) visible.push({ index: -1 });
    visible.push({ index: -1, more: { above, below } });
    return { rows: visible, top };
}

export function journeyMoreText(more: { readonly above: number; readonly below: number }, width = Infinity): string {
    const forms = [
        (n: number) => `${n} more ${n === 1 ? "model" : "models"}`,
        (n: number) => `${n} more`,
        (n: number) => `${n}`,
    ];
    const texts = forms.map((count) => [
        ...(more.above > 0 ? [`↑ ${count(more.above)}${count === forms[2] ? "" : " above"}`] : []),
        ...(more.below > 0 ? [`↓ ${count(more.below)}${count === forms[2] ? "" : " below"}`] : []),
    ].join(" · "));
    return texts.find((text) => Bun.stringWidth(text) <= width) ?? texts.at(-1)!;
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

export function journeyHeader(state: TuiSettingsPickerState, width = Infinity): string {
    if (state.modelJourney === "shortlist") return "";
    if (state.tab !== "all") return "";
    const description = "Models from your connected providers";
    const floor = state.intelligenceCutoff ?? "any";
    const hidden = state.allOptions.filter((row) => !passesIntelligenceCutoff(row.waScore, floor));
    const unscored = hidden.filter((row) => row.waScore === undefined).length;
    if (!hidden.length) return description;
    const count = `${hidden.length} hidden below the cutoff, including ${unscored} unscored models.`;
    return `${description}\n${count.length <= width ? count : `${hidden.length} hidden below the cutoff (${unscored} unscored)`}`;
}

export function journeyFooter(state: TuiSettingsPickerState): string {
    const selected = state.options[state.selectedIndex];
    const action = selected === undefined ? "Select a model"
        : selected.pooledRank === undefined ? "Add to library" : "Remove from library";
    const reveal = state.revealAll ? "Hide extra variants and older models" : "Show extra variants and older models";
    const navigation = state.modelFocus === "scope" ? "⏎ choose which models to show · arrows move sections"
        : state.modelFocus === "sort" ? "⏎ choose how models are sorted · arrows move sections"
        : state.modelFocus === "search" ? "Type to search · ←→ move cursor · ↑↓ sections"
        : state.modelFocus === "intelligence" ? "←→ change cutoff · ↑↓ sections"
        : state.modelFocus === "more" ? "⏎ open More · arrows move sections"
        : `↑↓ ^d^u choose · ⏎ switch model${selected === undefined ? "" : ` · ^s ${
            selected.pooledRank === undefined ? "add to library" : "remove from library"}`} · space fold`;
    return state.modelJourney === "shortlist"
        ? `⏎ / Ctrl+S  ${action}\nCtrl+A  ${reveal}\nCtrl+R Rename · Ctrl+Y Verify · Esc Back`
        : `› Ctrl+K More: ${state.tab === "all" ? "library, variants, refresh, defaults" : "library, refresh, defaults"}\n${navigation}\nTab / Shift+Tab sections · Esc back`;
}

/** The switch dialog always carries one of these, one per open. */
export const MODEL_SWITCH_TIPS: readonly string[] = [
    "Switching keeps the thread; the next turn uses the new model.",
    "Type from any section to search; Tab moves between sections.",
    "^g raises the WA Score cutoff, Shift+^g lowers it.",
    "^s adds the highlighted model to your library.",
    "Ctrl+K edits defaults: which model each role reaches for.",
];

export function modelSwitchTip(turn: number): string {
    const count = MODEL_SWITCH_TIPS.length;
    return MODEL_SWITCH_TIPS[((turn % count) + count) % count]!;
}

export function journeySections(state: TuiSettingsPickerState): readonly ModelJourneySection[] {
    return ["scope", "sort", "search", ...(state.tab === "all" ? ["intelligence" as const] : []), "list", "more"];
}

export function journeySortOptions(state: TuiSettingsPickerState): readonly TuiSettingsPickerOption[] {
    return [
        ...(state.tab === "all" ? [] : [{ value: "sort:library", label: "Library order", description: "" }]),
        { value: "sort:az", label: "A to Z", description: "" },
        { value: "sort:price", label: "Cheapest first", description: "" },
    ];
}

export function modelJourneySort(parent: TuiSettingsPickerState): TuiSettingsPickerState {
    const options = journeySortOptions(parent);
    return { kind: "model_menu", title: "Sort models", options, allOptions: options,
        selectedIndex: Math.max(0, options.findIndex((row) => row.value === `sort:${journeySort(parent)}`)), query: "", parent };
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
    const selected = parent.options[parent.selectedIndex];
    const options: TuiSettingsPickerOption[] = [
        ...(selected?.provider !== undefined && selected.model !== undefined
            ? [{ value: "library", label: selected.pooledRank === undefined
                ? "Add to your library" : "Remove from your library", description: "^s" }]
            : []),
        ...(parent.tab === "all" ? [{ value: "variants", label: parent.revealAll
            ? "Hide extra variants and older models" : "Show extra variants and older models", description: "" }] : []),
        { value: "refresh", label: "Refresh model catalog", description: "" },
        { value: "manage_library", label: "Manage your library", description: "" },
        { value: "defaults", label: "Edit model defaults", description: "" },
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
        if (value === "sort:library" || value === "sort:az" || value === "sort:price") return {
            state: rebuiltJourney({ ...parent, modelFocus: "list", journeySort: value.slice("sort:".length) as ModelJourneySort }, parent.options[parent.selectedIndex]?.value), handled: true,
        };
        if (state.options[state.selectedIndex]?.value === "variants") return {
            state: rebuiltJourney({ ...parent, revealAll: parent.revealAll !== true }, parent.options[parent.selectedIndex]?.value), handled: true,
        };
        if (state.options[state.selectedIndex]?.value === "refresh") return { state: parent, handled: true, refreshAllCatalogs: true };
        if (value === "manage_library") return { state: parent, handled: true, selection: { kind: "model_shortlist_open" } };
        if (value === "defaults") return { state: parent, handled: true, selection: { kind: "model_defaults_open" } };
        if (value === "library") {
            const row = parent.options[parent.selectedIndex];
            if (row?.provider === undefined || row.model === undefined) return { state: parent, handled: true };
            return { state: parent, handled: true,
                poolToggle: { action: row.pooledRank === undefined ? "add" : "remove",
                    provider: row.provider, model: row.model } };
        }
    }
    return { state, handled: true };
}

function toggledJourneyGroup(
    state: TuiSettingsPickerState,
    action: "close" | "open",
): TuiSettingsPickerTransition {
    const selected = state.options[state.selectedIndex];
    const group = selected?.group;
    if (group === undefined) return { state, handled: true };
    const collapsed = state.collapsed ?? [];
    const closed = collapsed.includes(group);
    if (closed === (action === "close")) return { state, handled: true };
    const next = action === "close"
        ? [...collapsed, group]
        : collapsed.filter((entry) => entry !== group);
    const options = journeyModels({ ...state, collapsed: next });
    // Closing leaves the cursor on the heading it just folded; opening puts it
    // on the first model under that heading.
    const landing = options.findIndex((row) =>
        row.group === group && (action === "close") === (row.section !== undefined));
    return {
        state: { ...state, collapsed: next, options,
            selectedIndex: Math.max(0, landing) },
        handled: true,
    };
}

function focusedMenu(state: TuiSettingsPickerState): TuiSettingsPickerState | undefined {
    if (state.modelFocus === "scope") return modelJourneyScope(state);
    if (state.modelFocus === "sort") return modelJourneySort(state);
    if (state.modelFocus === "more") return modelJourneyMenu(state);
    return undefined;
}

/** An arrow leaves a section only when it has no job inside it, edges included. */
function switchArrowKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey): TuiSettingsPickerTransition | undefined {
    const same = { state, handled: true };
    const focus = (state.modelFocus ?? "list") as ModelJourneySection;
    const sections = journeySections(state);
    const at = sections.indexOf(focus);
    if (key.name === "space") {
        if (focus === "list") {
            const heading = state.options[state.selectedIndex]?.section !== undefined;
            return toggledJourneyGroup(state, heading ? "open" : "close");
        }
        const menu = focusedMenu(state);
        return menu === undefined ? same : { state: menu, handled: true };
    }
    const vertical = key.name === "up" || key.name === "down";
    const horizontal = key.name === "left" || key.name === "right";
    if (!vertical && !horizontal) return undefined;
    if (focus === "list" && vertical) return undefined;
    if (focus === "search" && horizontal) return same;
    if (focus === "intelligence" && horizontal) return { state: rebuiltJourney({ ...state,
        intelligenceCutoff: stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", key.name === "left" ? -1 : 1),
    }, state.options[state.selectedIndex]?.value), handled: true };
    // Any arrow the section does not use walks the Tab order and wraps like Tab.
    const step = key.name === "down" || key.name === "right" ? 1 : -1;
    return { state: { ...state, modelFocus: sections[(at + step + sections.length) % sections.length]! }, handled: true };
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
        return selected?.provider && selected.model ? { ...same,
            poolToggle: { action: selected.pooledRank === undefined ? "add" : "remove",
                provider: selected.provider, model: selected.model } } : same;
    }
    const binding = tuiBindingId(managing ? "shortlist_picker" : "switch_model_picker", key);
    if (binding === "journey_more") return { state: modelJourneyMenu(state), handled: true };
    if (key.name === "escape" || key.name === "esc") return { state: state.parent, handled: true };
    if (!managing && !key.ctrl && !key.meta) {
        const arrowed = switchArrowKey(state, key);
        if (arrowed !== undefined) return arrowed;
    }
    if (managing && (key.name === "left" || key.name === "right")) {
        return toggledJourneyGroup(state, key.name === "left" ? "close" : "open");
    }
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
        const menu = focusedMenu(state);
        if ((key.name === "enter" || key.name === "return") && menu !== undefined) return { state: menu, handled: true };
        return same;
    }
    if (key.name === "up" || key.name === "down") return { handled: true, state: { ...state,
        selectedIndex: Math.max(0, Math.min(state.options.length - 1, state.selectedIndex + (key.name === "up" ? -1 : 1))) } };
    if ((key.name === "enter" || key.name === "return") && selected?.section !== undefined) {
        return toggledJourneyGroup(state, "open");
    }
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
