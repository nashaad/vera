import { halfPageCursor } from "./list-window.ts";
import { sectionHeader } from "./settings-picker-model.ts";
import { tuiBindingId } from "./keymap.ts";
import { arrowMovesForward, sectionArrow, steppedSection } from "./section-keys.ts";
import { passesIntelligenceCutoff, stepIntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import { blendedRate } from "../../src/model/listed-rates.ts";
import type { ModelBrowseSection, ModelBrowseSort, TuiModelPickerTab, TuiSettingsPickerKey, TuiSettingsPickerOption, TuiSettingsPickerState, TuiSettingsPickerTransition } from "./settings-picker-types.ts";

/** The three browse scopes, in the order Ctrl+G walks them. */
const BROWSE_SCOPES: readonly TuiModelPickerTab[] = ["pool", "recommended", "all"];

export function nextBrowseScope(
    tab: TuiModelPickerTab | undefined,
    forward = true,
): TuiModelPickerTab {
    const count = BROWSE_SCOPES.length;
    const at = Math.max(0, BROWSE_SCOPES.indexOf(tab ?? "pool"));
    return BROWSE_SCOPES[(at + (forward ? 1 : count - 1)) % count]!;
}

/** What the scope in front of you holds, and what Enter does to a row in it. */
export function browseScopeCaption(tab: TuiModelPickerTab | undefined): string {
    if (tab === "all") {
        return "Every model your providers offer. Press Ctrl+G to switch to Recommended, a shorter list.";
    }
    if (tab === "recommended") {
        return "A short list, picked by hand and refreshed daily. Press Ctrl+G to see every model.";
    }
    return "Models you saved, in the order you added them. \u23ce removes one.";
}

export function browseScopeLabel(tab: TuiModelPickerTab | undefined): string {
    return tab === "all" ? "All connected" : tab === "recommended" ? "Recommended" : "Favorites";
}

export function browseMatches(state: TuiSettingsPickerState, revealAll = state.revealAll === true): readonly TuiSettingsPickerOption[] {
    const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return state.allOptions.filter((row) => (state.providerCatalogs === undefined || row.description !== "current model" || row.pooledRank !== undefined) && row.model !== undefined && row.provider !== undefined
        && (state.modelBrowse === "favorites" || terms.length > 0 || inBrowseScope(state, row))
        && (state.browseProvider === undefined || row.provider === state.browseProvider)
        && (!state.browseAvailableOnly || !row.unavailable)
        && (!state.browsePricedOnly || row.pricing !== undefined)
        && (!state.browseImagesOnly || row.images === true)
        && (state.modelBrowse === "favorites"
            || passesIntelligenceCutoff(row.waScore, state.intelligenceCutoff ?? "any"))
        && (revealAll || terms.length > 0 || row.hiddenByDefault === undefined || row.pooledRank !== undefined
            || state.modelBrowse === "favorites" && state.browseRetainedModels?.includes(row.value))
        && terms.every((term) => `${row.label} ${row.provider} ${row.model}`.toLowerCase().includes(term)))
        .toSorted((a, b) => state.modelBrowse === "favorites"
            ? (a.provider ?? "").localeCompare(b.provider ?? "") || a.label.localeCompare(b.label)
            : 0);
}

/** A search always reaches the whole catalog, so scope only governs the resting list. */
function inBrowseScope(state: TuiSettingsPickerState, row: TuiSettingsPickerOption): boolean {
    if (state.tab === "all") return true;
    if (state.tab === "recommended") return row.recommended === true;
    return row.pooledRank !== undefined;
}

function sectionKey(state: TuiSettingsPickerState, row: TuiSettingsPickerOption): string {
    const bucket = state.modelBrowse === "favorites" ? "shortlist" : state.tab;
    return `${bucket}:${row.provider}`;
}

/** Library order exists only in Library models; Provider catalog falls back to A to Z. */
export function browseSort(state: TuiSettingsPickerState): ModelBrowseSort {
    const pooled = (state.tab ?? "pool") === "pool";
    const sort = state.browseSort ?? (pooled ? "library" : "az");
    return sort === "library" && !pooled ? "az" : sort;
}

function sortedWithinGroup(state: TuiSettingsPickerState, rows: readonly TuiSettingsPickerOption[]): readonly TuiSettingsPickerOption[] {
    const sort = state.modelBrowse === "browse" ? browseSort(state) : "library";
    if (sort === "library") return rows;
    return rows.toSorted((a, b) => {
        if (sort === "price") {
            const left = blendedRate(a.pricing), right = blendedRate(b.pricing);
            if (left !== right) return left === undefined ? 1 : right === undefined ? -1 : left - right;
        }
        return a.label.localeCompare(b.label);
    });
}

export function browseModels(state: TuiSettingsPickerState): readonly TuiSettingsPickerOption[] {
    const matches = browseMatches(state);
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

export interface BrowseDisplayRow {
    readonly option?: TuiSettingsPickerOption;
    readonly heading?: string;
    readonly more?: { readonly above: number; readonly below: number };
    readonly index: number;
}

export interface BrowseWindow {
    readonly rows: readonly BrowseDisplayRow[];
    /** The display line at the top of the window; pass it back on the next render so the list only moves when the cursor leaves it. */
    readonly top: number;
}

/** Every call shows the same number of lines, so one cursor step moves the list by at most one line. */
export function browseWindow(state: TuiSettingsPickerState, maxLines: number, previousTop = 0): BrowseWindow {
    const display: BrowseDisplayRow[] = state.options.flatMap((option, index) => [
        ...((index === 0 || option.group !== state.options[index - 1]?.group) && option.section === undefined
            ? [{ heading: option.group, index: -1 }] : []),
        { option, index },
    ]);
    if (display.length <= maxLines) return { rows: display, top: 0 };
    // The bottom lines are a gap and the count of models outside the window.
    const size = Math.max(1, maxLines - (maxLines > 2 ? 2 : 1));
    const cursor = Math.max(0, display.findIndex((row) => row.index === state.selectedIndex));
    // A model row on the top line keeps its group heading above it, wherever
    // that heading has scrolled to. The line it costs comes off the bottom.
    const stuckHeading = (at: number): string | undefined => {
        const row = size > 1 ? display[at] : undefined;
        return row?.option === undefined || row.option.section !== undefined
            ? undefined
            : row.option.group;
    };
    const body = (at: number) => size - (stuckHeading(at) === undefined ? 0 : 1);
    let top = Math.max(0, Math.min(previousTop, cursor));
    top = Math.min(top, Math.max(0, display.length - body(top)));
    for (let step = 0; step < display.length && cursor > top + body(top) - 1; step += 1) {
        top += 1;
    }
    const stuck = stuckHeading(top);
    const visible = display.slice(top, top + body(top));
    if (stuck !== undefined) visible.unshift({ heading: stuck, index: -1 });
    const shown = visible.flatMap((row) => row.option === undefined ? [] : [row.index]);
    if (maxLines < 2 || shown.length === 0) return { rows: visible, top };
    const models = (from: number, to: number) => state.options.slice(from, to).filter((row) => row.section === undefined).length;
    const above = models(0, Math.min(...shown));
    const below = models(Math.max(...shown) + 1, state.options.length);
    if (maxLines > 2) visible.push({ index: -1 });
    visible.push({ index: -1, more: { above, below } });
    return { rows: visible, top };
}

export function browseMoreText(more: { readonly above: number; readonly below: number }, width = Infinity): string {
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

function rebuiltBrowse(state: TuiSettingsPickerState, selectedValue?: string): TuiSettingsPickerState {
    const options = browseModels(state);
    const selected = options.findIndex((row) => row.value === selectedValue);
    return { ...state, options, selectedIndex: selected >= 0 ? selected : Math.max(0, options.findIndex((row) => row.model !== undefined)) };
}

export function modelBrowse(state: TuiSettingsPickerState, mode: "browse" | "favorites"): TuiSettingsPickerState {
    const next: TuiSettingsPickerState = { ...state,
        allOptions: state.providerCatalogs === undefined ? state.allOptions : state.allOptions.filter((row) => row.description !== "current model" || row.pooledRank !== undefined),
        modelBrowse: mode,
        browseRetainedModels: state.allOptions.filter((row) => row.pooledRank !== undefined).map((row) => row.value),
        title: mode === "browse" ? "Browse models" : "Favorites",
        browseView: state.browseView ?? "standard",
        tab: mode === "browse" ? state.tab ?? "pool" : "all", modelFocus: mode === "browse" ? "search" : "list", query: "", queryCursor: 0,
        selectedIndex: 0 };
    return rebuiltBrowse({ ...next, collapsed: [] }, state.initialModel);
}

export function browseHeader(state: TuiSettingsPickerState, width = Infinity): string {
    if (state.modelBrowse === "favorites") return "";
    if (state.tab !== "all") return "";
    const description = "Models from your connected providers";
    const floor = state.intelligenceCutoff ?? "any";
    const hidden = state.allOptions.filter((row) => !passesIntelligenceCutoff(row.waScore, floor));
    const unscored = hidden.filter((row) => row.waScore === undefined).length;
    if (!hidden.length) return description;
    const count = `${hidden.length} hidden below the cutoff, including ${unscored} unscored models.`;
    return `${description}\n${count.length <= width ? count : `${hidden.length} hidden below the cutoff (${unscored} unscored)`}`;
}

export function browseFooter(state: TuiSettingsPickerState): string {
    const selected = state.options[state.selectedIndex];
    const action = selected === undefined ? "Select a model"
        : selected.pooledRank === undefined ? "Add to favorites" : "Remove from favorites";
    const reveal = state.revealAll ? "Hide extra variants and older models" : "Show extra variants and older models";
    const navigation = state.modelFocus === "scope" ? "⏎ choose which models to show · arrows move sections"
        : state.modelFocus === "sort" ? "⏎ choose how models are sorted · arrows move sections"
        : state.modelFocus === "search" ? "Type to search · ←→ move cursor · ↑↓ sections"
        : state.modelFocus === "intelligence" ? "←→ change cutoff · ↑↓ sections"
        : state.modelFocus === "more" ? "⏎ open More · arrows move sections"
        : `↑↓ Ctrl+D/U choose · ⏎ / Ctrl+S ${selected === undefined ? "favorite"
            : selected.pooledRank === undefined ? "add to favorites" : "remove from favorites"} · Space fold/unfold`;
    const libraryNavigation = state.modelFocus === "search" ? "Type to search · ↑↓ sections" : "↑↓ choose · Space fold/unfold";
    return state.modelBrowse === "favorites"
        ? `⏎ / Ctrl+S  ${action}\nCtrl+A  ${reveal}\n${libraryNavigation} · Tab sections\nCtrl+R Rename · Ctrl+Y Verify · Esc Back`
        : `› Ctrl+K More: ${state.tab === "all" ? "favorites, variants, refresh, defaults" : "favorites, refresh, defaults"}\n${navigation}\nTab / Shift+Tab sections · Esc back`;
}

/** The browse page always carries one of these, one per open. */
export const MODEL_BROWSE_TIPS: readonly string[] = [
    "Browsing changes nothing that runs; /model switches the model.",
    "Type from any section to search; Tab moves between sections.",
    "Ctrl+G cycles Favorites, Recommended and All connected models.",
    "Enter or Ctrl+S favorites the highlighted model.",
    "Highlight a model and press Ctrl+K to manage it.",
];

export function modelBrowseTip(turn: number): string {
    const count = MODEL_BROWSE_TIPS.length;
    return MODEL_BROWSE_TIPS[((turn % count) + count) % count]!;
}

export function browseSections(state: TuiSettingsPickerState): readonly ModelBrowseSection[] {
    if (state.modelBrowse === "favorites") return ["search", "list"];
    return ["search", "list", "filters", "providers", "more"];
}

export function browseSortOptions(state: TuiSettingsPickerState): readonly TuiSettingsPickerOption[] {
    return [
        ...((state.tab ?? "pool") === "pool" ? [{ value: "sort:library", label: "Favorite order", description: "" }] : []),
        { value: "sort:az", label: "A to Z", description: "" },
        { value: "sort:price", label: "Cheapest first", description: "" },
    ];
}

export function modelBrowseSort(parent: TuiSettingsPickerState): TuiSettingsPickerState {
    const options = browseSortOptions(parent);
    return { kind: "model_menu", title: "Sort models", options, allOptions: options,
        selectedIndex: Math.max(0, options.findIndex((row) => row.value === `sort:${browseSort(parent)}`)), query: "", parent };
}

export function browseScopeOptions(state: TuiSettingsPickerState): readonly TuiSettingsPickerOption[] {
    const counts = { ...state, query: "", intelligenceCutoff: "any" as const };
    return [
        { value: "scope:pool", label: `Favorites (${state.allOptions.filter((row) => row.pooledRank !== undefined).length})`, description: "" },
        { value: "scope:recommended", label: `Recommended (${state.allOptions.filter((row) => row.recommended === true).length})`, description: "" },
        { value: "scope:all", label: `All connected (${browseMatches({ ...counts, tab: "all" }).filter((row) => !row.unavailable).length})`, description: "" },
    ];
}

export function modelBrowseScope(parent: TuiSettingsPickerState): TuiSettingsPickerState {
    const options = browseScopeOptions(parent);
    return { kind: "model_menu", title: "Show models", options, allOptions: options,
        selectedIndex: Math.max(0, options.findIndex((row) => row.value === `scope:${parent.tab ?? "pool"}`)), query: "", parent };
}

export function modelBrowseMenu(parent: TuiSettingsPickerState): TuiSettingsPickerState {
    const selected = parent.options[parent.selectedIndex];
    const options: TuiSettingsPickerOption[] = [
        ...(selected?.provider !== undefined && selected.model !== undefined
            ? [{ value: "library", label: selected.pooledRank === undefined
                ? "Add to favorites" : "Remove from favorites", description: selected.pooledRank === undefined ? "Save for quick access" : "Remove saved shortcut" }]
            : []),
        ...(parent.tab === "all" ? [{ value: "variants", label: parent.revealAll
            ? "Hide extra variants and older models" : "Show extra variants and older models", description: "Change catalog visibility" }] : []),
        { value: "refresh", label: "Refresh model catalog", description: "Reload connected catalogs" },
        { value: "manage_library", label: "Add/remove favorites", description: "Choose your saved models" },
        ...(selected?.provider !== undefined && selected.model !== undefined
            ? [{ value: "verify_selected", label: "Verify this model", description: "Check that it still answers" }]
            : []),
        ...(parent.allOptions.some((row) => row.pooledRank !== undefined)
            ? [{ value: "verify", label: "Verify favorites", description: "Check that they still answer" }]
            : []),
        { value: "defaults", label: "Edit model defaults", description: "Choose models for roles" },
        { value: "providers", label: "Configure providers", description: "Manage provider connections" },
    ];
    const provider = parent.providerCatalogs?.find((row) => row.id === selected?.provider)?.label ?? selected?.provider;
    return { kind: "model_menu", title: "Manage models", options, allOptions: options,
        ...(selected?.model !== undefined && provider !== undefined ? { subtitle: `Selected: ${selected.label} · ${provider}` } : {}),
        selectedIndex: 0, query: "", parent };
}

export function handleModelBrowseMenuKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey): TuiSettingsPickerTransition {
    const parent = state.parent;
    if (key.name === "escape" || key.name === "esc" || (state.title === "Manage models" && tuiBindingId("switch_model_picker", key) === "journey_more")) {
        return { state: parent, handled: true };
    }
    if (state.options[state.selectedIndex]?.value === "cutoff" && (key.name === "left" || key.name === "right")) {
        return { state: setModelFilterCutoff(state, stepIntelligenceCutoff(parent?.intelligenceCutoff ?? "any", key.name === "right" ? 1 : -1)), handled: true };
    }
    if (key.name === "up" || key.name === "down") return { handled: true, state: { ...state,
        selectedIndex: Math.max(0, Math.min(state.options.length - 1, state.selectedIndex + (key.name === "up" ? -1 : 1))) } };
    if ((key.name === "enter" || key.name === "return") && parent?.kind === "model") {
        const value = state.options[state.selectedIndex]?.value;
        // Choices made from Filter and sort, or a list it opened, land back on it.
        const fromFilters = parent.modelFocus === "filters";
        const inFilters = fromFilters && state.title === "Filter and sort";
        const stay = (next: TuiSettingsPickerState, row: string): TuiSettingsPickerTransition =>
            ({ state: filtersMenu(next, row), handled: true });
        if (value === "view_toggle") return stay({ ...parent, browseView: parent.browseView === "detailed" ? "standard" : "detailed" }, "view_toggle");
        if (value === "view:standard" || value === "view:detailed") return {
            state: { ...parent, browseView: value === "view:standard" ? "standard" : "detailed" }, handled: true,
        };
        if (value === "show") return { state: modelBrowseScope(parent), handled: true };
        if (value === "sort") return { state: modelBrowseSort(parent), handled: true };
        // Arrows already applied the cutoff, so Enter just confirms it.
        if (value === "cutoff") return { state: { ...parent, modelFocus: "list" }, handled: true };
        if (value?.startsWith("cutoff:")) return { state: rebuiltBrowse({ ...parent, intelligenceCutoff: value.slice(7) as TuiSettingsPickerState["intelligenceCutoff"] }), handled: true };
        if (value === "provider_filter") return { state: browseChoiceMenu(parent, "Filter provider", [
            { value: "provider:", label: "Any provider", description: "" },
            ...[...new Set(parent.allOptions.flatMap((row) => row.provider === undefined ? [] : [row.provider]))].sort().map((provider) => ({ value: `provider:${provider}`, label: provider, description: "" })),
        ]), handled: true };
        if (value?.startsWith("provider:")) return stay(rebuiltBrowse({ ...parent, browseProvider: value.slice(9) || undefined }), "provider_filter");
        if (value === "available_filter") return stay(rebuiltBrowse({ ...parent, browseAvailableOnly: !parent.browseAvailableOnly }), value);
        if (value === "priced_filter") return stay(rebuiltBrowse({ ...parent, browsePricedOnly: !parent.browsePricedOnly }), value);
        if (value === "images_filter") return stay(rebuiltBrowse({ ...parent, browseImagesOnly: !parent.browseImagesOnly }), value);
        if (value === "clear_filters") return stay(rebuiltBrowse({ ...parent, intelligenceCutoff: "any", revealAll: false, browseProvider: undefined, browseAvailableOnly: false, browsePricedOnly: false, browseImagesOnly: false }), value);
        if (value === "providers") return { state: parent, handled: true, openProviders: true };
        if (value?.startsWith("scope:") === true) {
            const tab = value.slice("scope:".length) as TuiModelPickerTab;
            if (fromFilters) return stay(rebuiltBrowse({ ...parent, tab }, parent.options[parent.selectedIndex]?.value), "show");
            return { state: rebuiltBrowse({ ...parent, modelFocus: "list", tab }, parent.options[parent.selectedIndex]?.value), handled: true };
        }
        if (value === "sort:library" || value === "sort:az" || value === "sort:price") {
            const browseSort = value.slice("sort:".length) as ModelBrowseSort;
            if (fromFilters) return stay(rebuiltBrowse({ ...parent, browseSort }, parent.options[parent.selectedIndex]?.value), "sort");
            return { state: rebuiltBrowse({ ...parent, modelFocus: "list", browseSort }, parent.options[parent.selectedIndex]?.value), handled: true };
        }
        if (value === "variants") {
            const next = rebuiltBrowse({ ...parent, revealAll: parent.revealAll !== true }, parent.options[parent.selectedIndex]?.value);
            return inFilters ? stay(next, "variants") : { state: next, handled: true };
        }
        if (state.options[state.selectedIndex]?.value === "refresh") return { state: parent, handled: true, refreshAllCatalogs: true };
        if (value === "manage_library") return { state: parent, handled: true, selection: { kind: "model_shortlist_open" } };
        if (value === "verify") return { state: parent, handled: true, poolVerifySweep: true };
        if (value === "verify_selected") {
            const row = parent.options[parent.selectedIndex];
            if (row?.provider === undefined || row.model === undefined) return { state, handled: true };
            return { state: parent, handled: true, poolVerify: { provider: row.provider, model: row.model } };
        }
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

export function setModelFilterCutoff(state: TuiSettingsPickerState, cutoff: TuiSettingsPickerState["intelligenceCutoff"]): TuiSettingsPickerState {
    if (state.kind !== "model_menu" || state.parent?.kind !== "model" || !state.options.some((row) => row.value === "cutoff")) return state;
    const options = state.options.map((row) => row.value === "cutoff" ? { ...row, label: `Intelligence cutoff: ${cutoff ?? "any"}` } : row);
    return { ...state, options, allOptions: options,
        selectedIndex: options.findIndex((row) => row.value === "cutoff"),
        parent: rebuiltBrowse({ ...state.parent, intelligenceCutoff: cutoff ?? "any" }) };
}

function toggledBrowseGroup(
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
    const options = browseModels({ ...state, collapsed: next });
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
    if (state.modelFocus === "view") return browseChoiceMenu(state, "Model view", [
        { value: "view:standard", label: "Standard", description: "" },
        { value: "view:detailed", label: "Detailed", description: "" },
    ]);
    if (state.modelFocus === "filters") return filtersMenu(state);
    if (state.modelFocus === "scope") return modelBrowseScope(state);
    if (state.modelFocus === "sort") return modelBrowseSort(state);
    if (state.modelFocus === "more") return modelBrowseMenu(state);
    return undefined;
}

function filtersMenu(state: TuiSettingsPickerState, selectedValue?: string): TuiSettingsPickerState {
    const menu = browseChoiceMenu(state, "Filter and sort", [
        { value: "show", label: `Show: ${browseScopeLabel(state.tab)}`, description: "" },
        { value: "view_toggle", label: `View: ${state.browseView === "detailed" ? "Detailed" : "Standard"}`, description: "" },
        { value: "sort", label: `Sort: ${browseSortOptions(state).find((option) => option.value === `sort:${browseSort(state)}`)!.label}`, description: "" },
        { value: "provider_filter", label: `Provider: ${state.browseProvider ?? "Any"}`, description: "" },
        { value: "available_filter", label: `Available only: ${state.browseAvailableOnly ? "On" : "Off"}`, description: "" },
        { value: "priced_filter", label: `Known price only: ${state.browsePricedOnly ? "On" : "Off"}`, description: "" },
        { value: "images_filter", label: `Image support only: ${state.browseImagesOnly ? "On" : "Off"}`, description: "" },
        { value: "cutoff", label: `Intelligence cutoff: ${state.intelligenceCutoff ?? "any"}`, description: "" },
        { value: "variants", label: state.revealAll ? "Hide extra variants and older models" : "Show extra variants and older models", description: "" },
        { value: "clear_filters", label: "Clear filters", description: "" },
    ]);
    return { ...menu, selectedIndex: Math.max(0, menu.options.findIndex((row) => row.value === selectedValue)) };
}

function browseChoiceMenu(parent: TuiSettingsPickerState, title: string, options: readonly TuiSettingsPickerOption[]): TuiSettingsPickerState {
    return { kind: "model_menu", title, options, allOptions: options, selectedIndex: 0, query: "", parent };
}

/** An arrow leaves a section only when it has no job inside it, edges included. */
function browseArrowKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey): TuiSettingsPickerTransition | undefined {
    const same = { state, handled: true };
    const focus = (state.modelFocus ?? "list") as ModelBrowseSection;
    if (focus === "providers" && ["enter", "return", "space"].includes(key.name)) return { ...same, openProviders: true };
    if (key.name === "space") {
        if (focus === "list") {
            const heading = state.options[state.selectedIndex]?.section !== undefined;
            return toggledBrowseGroup(state, heading ? "open" : "close");
        }
        const menu = focusedMenu(state);
        return menu === undefined ? same : { state: menu, handled: true };
    }
    const arrow = sectionArrow(key.name);
    if (arrow === undefined) return undefined;
    const vertical = arrow === "up" || arrow === "down";
    if (focus === "list" && vertical) return undefined;
    if (focus === "search" && !vertical) return same;
    if (focus === "intelligence" && !vertical) return { state: rebuiltBrowse({ ...state,
        intelligenceCutoff: stepIntelligenceCutoff(state.intelligenceCutoff ?? "any", arrow === "left" ? -1 : 1),
    }, state.options[state.selectedIndex]?.value), handled: true };
    return { state: { ...state, modelFocus: steppedSection(browseSections(state), focus, arrowMovesForward(arrow)) }, handled: true };
}

export function handleModelBrowseKey(state: TuiSettingsPickerState, key: TuiSettingsPickerKey, viewportRows = 12): TuiSettingsPickerTransition {
    const same = { state, handled: true };
    const selected = state.options[state.selectedIndex];
    const managing = state.modelBrowse === "favorites";
    const focus = (state.modelFocus ?? "list") as ModelBrowseSection;
    const sectionBinding = tuiBindingId(managing ? "shortlist_picker" : "switch_model_picker", key);
    if (sectionBinding === "journey_section" || sectionBinding === "shortlist_section") return { handled: true,
        state: { ...state, modelFocus: steppedSection(browseSections(state), focus, !(key.shift || key.name === "backtab")) } };
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
    if (binding === "journey_more") return { state: modelBrowseMenu(state), handled: true };
    if (key.name === "escape" || key.name === "esc") return { state: state.parent, handled: true };
    if (!key.ctrl && !key.meta) {
        const arrowed = browseArrowKey(state, key);
        if (arrowed !== undefined) return arrowed;
    }
    if (binding !== undefined || key.ctrl) {
        if (binding === "journey_reveal" || binding === "shortlist_reveal") return { state: rebuiltBrowse({ ...state, revealAll: state.revealAll !== true }, selected?.value), handled: true };
        if (binding === "shortlist_providers") return { ...same, openProviders: true };
        if (binding === "journey_refresh") return { ...same, refreshAllCatalogs: true };
        if (binding === "journey_scope") {
            return { state: rebuiltBrowse({ ...state, tab: nextBrowseScope(state.tab, key.shift !== true) }, selected?.value), handled: true };
        }
        if (managing && selected?.provider && selected.model) {
            if (binding === "shortlist_rename") return { ...same, poolName: { provider: selected.provider, model: selected.model, label: selected.label } };
            if (binding === "shortlist_verify") return { ...same, poolVerify: { provider: selected.provider, model: selected.model } };
        }
        return same;
    }
    if (focus !== "list") {
        const enter = key.name === "enter" || key.name === "return";
        const menu = focusedMenu(state);
        if (enter && menu !== undefined) return { state: menu, handled: true };
        // Enter in Search acts on the highlighted row, as it would in the list.
        if (!(enter && focus === "search")) return same;
    }
    if (key.name === "up" || key.name === "down") return { handled: true, state: { ...state,
        selectedIndex: Math.max(0, Math.min(state.options.length - 1, state.selectedIndex + (key.name === "up" ? -1 : 1))) } };
    if ((key.name === "enter" || key.name === "return") && selected?.section !== undefined) {
        return toggledBrowseGroup(state, "open");
    }
    if ((key.name === "enter" || key.name === "return") && selected?.provider && selected.model) {
        // Neither mode switches the model: this page never changes what runs next.
        return { ...same, poolToggle: { action: selected.pooledRank === undefined ? "add" : "remove",
            provider: selected.provider, model: selected.model } };
    }
    return { state, handled: false };
}

export function emptyModelBrowse(state: TuiSettingsPickerState): string {
    if (state.providerCatalogs?.length === 0) return "No provider connected. Open Connect provider below.";
    const never = state.providerCatalogs?.filter((provider) => provider.refreshedAt === undefined) ?? [];
    if (state.allOptions.length === 0 && never.length) return `${never.map((provider) => provider.label).join(", ")}: catalog never refreshed. Ctrl+R reads it now.`;
    if (state.allOptions.length === 0) return "No models in the connected catalogs. Open Connect provider below.";
    if (state.query) return "No models match your search. Clear the search to see models.";
    if (state.browseProvider || state.browseAvailableOnly || state.browsePricedOnly || state.browseImagesOnly
        || state.intelligenceCutoff && state.intelligenceCutoff !== "any") return "No models match these filters. Open Filter and sort to clear them.";
    if (state.modelBrowse === "browse" && state.tab === "recommended") return "No recommended models for the connected providers. Ctrl+G shows all of them.";
    if (state.modelBrowse === "browse" && state.tab !== "all") return "No favorites yet. Ctrl+G shows the recommended models, then all of them.";
    return "No models pass this cutoff. Open Filter and sort to change it.";
}
