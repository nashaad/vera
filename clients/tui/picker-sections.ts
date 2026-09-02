/** The model picker's sections: the bands a reader already sees as separate, made addressable. Tab moves between them, arrows stay inside one, and the ring is derived from what a tab actually shows rather than written down per tab. */

import {
    modelDetailActions,
    modelPageEntry,
    showsIntelligenceCutoff,
} from "./settings-picker-model.ts";
import type {
    TuiAnySettingsPickerState,
    TuiSettingsPickerState,
} from "./settings-picker-types.ts";

export type TuiPickerSectionId = "more" | "cutoff" | "list" | "details";

/** Drawing order, which is also ring order. */
const SECTION_ORDER: readonly TuiPickerSectionId[] = [
    "more",
    "cutoff",
    "list",
    "details",
];

/** Where each section keeps its focus. The list holds two, because its trailing action is a row of the list rather than a section beside it. */
const SECTION_FOCUS: Readonly<
    Record<TuiPickerSectionId, NonNullable<TuiSettingsPickerState["modelFocus"]>>
> = {
    more: "page_entry",
    cutoff: "intelligence",
    list: "list",
    details: "detail",
};

export function pickerSectionPresent(
    state: TuiAnySettingsPickerState,
    id: TuiPickerSectionId,
): boolean {
    if (state.kind !== "model") return false;
    if (id === "list") return true;
    if (id === "more") return modelPageEntry(state) !== undefined;
    if (id === "cutoff") return showsIntelligenceCutoff(state);
    return modelDetailActions(state, state.options[state.selectedIndex])
        .length > 0;
}

/** The sections on the tab in front of the user. Shortlist has no cutoff filter, so its ring is shorter; nothing is special-cased for it. */
export function pickerSections(
    state: TuiAnySettingsPickerState,
): readonly TuiPickerSectionId[] {
    return SECTION_ORDER.filter((id) => pickerSectionPresent(state, id));
}

export function focusedPickerSection(
    state: TuiAnySettingsPickerState,
): TuiPickerSectionId {
    const focus = state.kind === "model" ? state.modelFocus ?? "list" : "list";
    if (focus === "page_entry" || focus === "page") return "more";
    if (focus === "intelligence") return "cutoff";
    if (focus === "detail") return "details";
    return "list";
}

/** The section tab reaches next, wrapping inside the page. Undefined when the page holds one section and there is nowhere to go. */
export function steppedPickerSection(
    state: TuiAnySettingsPickerState,
    delta: 1 | -1,
): TuiPickerSectionId | undefined {
    const ring = pickerSections(state);
    if (ring.length < 2) return undefined;
    const at = ring.indexOf(focusedPickerSection(state));
    const from = at === -1 ? 0 : at;
    return ring[(from + delta + ring.length) % ring.length];
}

/** Whether shift+tab from here leaves the page rather than wrapping: the first section is the top of the ring, and above it is the tab strip. */
export function atFirstPickerSection(
    state: TuiAnySettingsPickerState,
): boolean {
    return pickerSections(state)[0] === focusedPickerSection(state);
}

/** Focus a section, leaving every other section's cursor where it was. */
export function focusedOnSection(
    state: TuiSettingsPickerState,
    id: TuiPickerSectionId,
): TuiSettingsPickerState {
    return id === "details"
        ? { ...state, modelFocus: "detail", modelActionIndex: 0 }
        : { ...state, modelFocus: SECTION_FOCUS[id] };
}

/** Focus repaired after the page changed under it. A tab switch, a cutoff that empties the list, or a search that removes the selected row can all leave focus on a section that is no longer there; it falls to the first one that is. */
export function repairedSectionFocus(
    state: TuiSettingsPickerState,
): TuiSettingsPickerState {
    if (state.kind !== "model") return state;
    const focused = focusedPickerSection(state);
    if (pickerSectionPresent(state, focused)) return state;
    const first = pickerSections(state)[0];
    return first === undefined ? state : focusedOnSection(state, first);
}
