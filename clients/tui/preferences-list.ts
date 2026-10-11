
import {
    dialogBoxHeight,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type {
    PermissionInspection,
    PermissionPredicate,
} from "../../src/engine/permissions.ts";
import { TUI_MUTED, TUI_PANEL } from "./state.ts";
import {
    dialogHeaderNode,
    dialogOptionRow,
    dialogRowPointer,
    centeredDialogSurface,
    type DialogRowPointer,
} from "./dialog-chrome.ts";
import { isTuiDialTabKey, tuiBindingId, tuiKeyHint } from "./keymap.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";

const PREFERENCES_CHROME = 8;

const PREFERENCES_TOP_OFFSET = 2;

// Row text is pre-wrapped to the box width; padding is two columns a side.
const PREFERENCES_WIDTH_SHARE = 0.8;

const PREFERENCES_PADDING = 4;

export type TuiPermissionEntryKind = "grant" | "preference";

export interface TuiPermissionEntry {
    readonly kind: TuiPermissionEntryKind;
    readonly id: string;
    readonly when: PermissionPredicate;
}

export interface TuiPreferencesListState {
    readonly entries: readonly TuiPermissionEntry[];
    readonly selectedIndex: number;
}

export interface TuiPreferencesListTransition {
    readonly state?: TuiPreferencesListState;
    readonly remove?: TuiPermissionEntry;
    readonly handled: boolean;
}

export interface TuiPreferencesListView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    pointer?: DialogRowPointer;
    update(state: TuiPreferencesListState): void;
}

export interface TuiPreferencesListKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export function startTuiPreferencesList(
    inspection: PermissionInspection | undefined,
): TuiPreferencesListState {
    return { entries: entriesFrom(inspection), selectedIndex: 0 };
}

export function syncTuiPreferencesList(
    state: TuiPreferencesListState,
    inspection: PermissionInspection | undefined,
): TuiPreferencesListState {
    const entries = entriesFrom(inspection);
    return {
        entries,
        selectedIndex: Math.max(
            0,
            Math.min(state.selectedIndex, entries.length - 1),
        ),
    };
}

export function handleTuiPreferencesListKey(
    state: TuiPreferencesListState,
    key: TuiPreferencesListKey,
): TuiPreferencesListTransition {
    if (isTuiDialTabKey(key) && !key.ctrl && !key.meta) {
        return { state, handled: true };
    }
    if (key.ctrl || key.meta || key.super || key.hyper || key.shift) {
        return { state, handled: false };
    }
    if (key.name === "escape") {
        return { handled: true };
    }
    if (key.name === "up") {
        return {
            state: {
                ...state,
                selectedIndex: Math.max(0, state.selectedIndex - 1),
            },
            handled: true,
        };
    }
    if (key.name === "down") {
        return {
            state: {
                ...state,
                selectedIndex: Math.min(
                    state.entries.length - 1,
                    state.selectedIndex + 1,
                ),
            },
            handled: true,
        };
    }
    if (key.name === "left" || key.name === "right" || key.name === "space") {
        return { state, handled: true };
    }
    if (tuiBindingId("preferences_list", key) === "revoke_permission") {
        const selected = state.entries[state.selectedIndex];
        return selected === undefined
            ? { state, handled: true }
            : { state, remove: selected, handled: true };
    }
    return { state, handled: false };
}

export function renderTuiPreferencesList(
    state: TuiPreferencesListState,
): string {
    if (state.entries.length === 0) {
        return "Nothing granted yet. Answer an approval with 2 or 4 to add something.";
    }
    const lines: string[] = [];
    let group: TuiPermissionEntryKind | undefined;
    for (const [index, entry] of state.entries.entries()) {
        if (entry.kind !== group) {
            group = entry.kind;
            lines.push(groupLabel(group));
        }
        lines.push(
            `${index === state.selectedIndex ? ">" : " "} ${
                formatPredicate(entry.when)
            }`,
        );
    }
    return lines.join("\n");
}

export function createTuiPreferencesListView(
    renderer: RenderContext,
): TuiPreferencesListView {
    const rows = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexDirection: "column",
    });
    const footer = new TextRenderable(renderer, {
        content: `[↑↓] move · ${tuiKeyHint("revoke_permission")} · [esc] close`,
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
        paddingLeft: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "preferences-list",
        border: false,
        backgroundColor: TUI_PANEL,
        width: `${PREFERENCES_WIDTH_SHARE * 100}%`,
        height: "auto",
        maxHeight: "90%",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
    });
    box.add(dialogHeaderNode(renderer, "Granted permissions"));
    box.add(rows);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "preferences-list-surface", box);

    let current: (BoxRenderable | TextRenderable)[] = [];
    const view: TuiPreferencesListView = {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        update(state): void {
            for (const row of current) {
                row.destroyRecursively();
            }
            current = [];
            if (state.entries.length === 0) {
                const empty = dialogOptionRow(renderer, {
                    label: "Nothing granted yet",
                    description: "answer an approval with 2 or 4 to add something",
                    active: false,
                });
                rows.add(empty);
                current.push(empty);
                return;
            }
            let group: TuiPermissionEntryKind | undefined;
            for (const { index, entry } of visibleRows(renderer, state)) {
                if (entry.kind !== group) {
                    group = entry.kind;
                    const header = new TextRenderable(renderer, {
                        content: groupLabel(group),
                        fg: TUI_MUTED,
                        width: "100%",
                        height: 1,
                        paddingLeft: 1,
                    });
                    rows.add(header);
                    current.push(header);
                }
                const row = dialogOptionRow(renderer, {
                    label: wrappedLines(
                        formatPredicate(entry.when),
                        rowWidth(renderer),
                    ).join("\n"),
                    wrap: true,
                    active: index === state.selectedIndex,
                    ...dialogRowPointer(view.pointer, index),
                });
                rows.add(row);
                current.push(row);
            }
        },
    };
    return view;
}

interface NumberedEntry {
    readonly index: number;
    readonly entry: TuiPermissionEntry;
}

function entriesFrom(
    inspection: PermissionInspection | undefined,
): readonly TuiPermissionEntry[] {
    if (inspection === undefined) {
        return [];
    }
    return [
        ...inspection.activeGrants.map((grant) => ({
            kind: "grant" as const,
            id: grant.id,
            when: grant.when,
        })),
        ...(inspection.activePreferences ?? []).map((preference) => ({
            kind: "preference" as const,
            id: preference.id,
            when: preference.when,
        })),
    ];
}

function groupLabel(kind: TuiPermissionEntryKind): string {
    return kind === "grant"
        ? "Session grants (expire when this session ends)"
        : "Durable preferences (kept across sessions)";
}

function visibleRows(
    renderer: RenderContext,
    state: TuiPreferencesListState,
): readonly NumberedEntry[] {
    const entries = state.entries.map((entry, index) => ({ index, entry }));
    const budget = listWindowRows(
        Math.min(
            dialogBoxHeight(renderer, PREFERENCES_TOP_OFFSET),
            renderer.height * 0.9,
        ),
        PREFERENCES_CHROME,
    );
    const width = rowWidth(renderer);
    const heights = state.entries.map((entry) =>
        wrappedLines(formatPredicate(entry.when), width).length
    );
    if (heights.every((height) => height === 1)) {
        return listWindowSlice(entries, state.selectedIndex, budget);
    }
    // Grow outward from the cursor, above first, until the line budget is spent.
    let start = Math.max(0, state.selectedIndex);
    let end = start + 1;
    let used = heights[start] ?? 0;
    let grew = true;
    while (grew) {
        grew = false;
        const above = heights[start - 1];
        if (above !== undefined && used + above <= budget) {
            start -= 1;
            used += above;
            grew = true;
        }
        const below = heights[end];
        if (below !== undefined && used + below <= budget) {
            end += 1;
            used += below;
            grew = true;
        }
    }
    return entries.slice(start, end);
}

function rowWidth(renderer: RenderContext): number {
    return Math.max(
        1,
        Math.floor(renderer.width * PREFERENCES_WIDTH_SHARE) - PREFERENCES_PADDING,
    );
}

// Breaks after ", " or "/" when one falls in the back half of the line, so a
// path splits between folders; anything else breaks at the width.
function wrappedLines(text: string, width: number): readonly string[] {
    const lines: string[] = [];
    let rest = text;
    while (rest.length > width) {
        const window = rest.slice(0, width);
        const breakAt = Math.max(
            window.lastIndexOf(", ") + 2,
            window.lastIndexOf("/") + 1,
        );
        const cut = breakAt > width / 2 ? breakAt : width;
        lines.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut);
    }
    lines.push(rest);
    return lines;
}

export function handleTuiPreferencesListScroll(
    state: TuiPreferencesListState,
    scroll: {
        readonly direction: "up" | "down" | "left" | "right";
        readonly delta: number;
    },
): { readonly state: TuiPreferencesListState; readonly handled: boolean } {
    const selectedIndex = wheelCursor(
        state.selectedIndex,
        state.entries.length,
        scroll,
    );
    return selectedIndex === undefined
        ? { state, handled: false }
        : { state: { ...state, selectedIndex }, handled: true };
}

function formatPredicate(predicate: PermissionPredicate): string {
    return Object.entries(predicate)
        .map(([field, value]) => `${field}=${String(value)}`)
        .join(", ");
}
