/**
 * The durable half of the permission model, made visible and removable.
 *
 * Deliberately a separate overlay from the settings picker rather than a sixth
 * picker kind. The picker swallows every single-character key into its search
 * query (`handleTuiSettingsPickerKey`), which is why session trash is bound to
 * `delete` and not to `d`. A three-entry preferences list wants plain keys and
 * has nothing to search, while a fifty-entry model list needs the filter, so
 * the two do not fit one component.
 *
 * Deliberately a separate command from `/permissions` too: a permission mode is
 * session-scoped and a preference outlives the session, so the two surfaces
 * mirror the tier boundary instead of blurring it.
 */

import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type {
    PermissionInspection,
    PermissionPredicate,
    PermissionPreference,
} from "../../src/engine/permissions.ts";
import { TUI_MUTED, TUI_PANEL } from "./state.ts";
import { dialogHeaderNode, dialogOptionRow } from "./dialog-chrome.ts";

/** Rows shown at once before the list windows around the cursor. */
const MAX_ROWS = 10;

export interface TuiPreferencesListState {
    readonly preferences: readonly PermissionPreference[];
    readonly selectedIndex: number;
}

export interface TuiPreferencesListTransition {
    /** Absent means the overlay closed. */
    readonly state?: TuiPreferencesListState;
    /** Set when the user asked to remove the highlighted preference. */
    readonly removeId?: string;
    readonly handled: boolean;
}

export interface TuiPreferencesListView {
    readonly box: BoxRenderable;
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
    return {
        preferences: inspection?.activePreferences ?? [],
        selectedIndex: 0,
    };
}

/**
 * Folds a refreshed inspection into an open overlay, which is how a removal
 * becomes visible: the engine replies with a full inspection rather than an
 * acknowledgement, so the list is never reconstructed client-side. The cursor
 * is clamped because the list it pointed into just got shorter.
 */
export function syncTuiPreferencesList(
    state: TuiPreferencesListState,
    inspection: PermissionInspection | undefined,
): TuiPreferencesListState {
    const preferences = inspection?.activePreferences ?? [];
    return {
        preferences,
        selectedIndex: Math.max(
            0,
            Math.min(state.selectedIndex, preferences.length - 1),
        ),
    };
}

export function handleTuiPreferencesListKey(
    state: TuiPreferencesListState,
    key: TuiPreferencesListKey,
): TuiPreferencesListTransition {
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
                    state.preferences.length - 1,
                    state.selectedIndex + 1,
                ),
            },
            handled: true,
        };
    }
    if (key.name === "delete" || key.name === "backspace") {
        const selected = state.preferences[state.selectedIndex];
        // No confirmation step, unlike session trash. Removing a preference can
        // only make Vera ask more often: it restores a prompt the user had
        // silenced, so the destructive direction here is the safe one.
        return selected === undefined
            ? { state, handled: true }
            : { state, removeId: selected.id, handled: true };
    }
    return { state, handled: false };
}

/** Plain-text form, used for the notice fallback and by tests. */
export function renderTuiPreferencesList(
    state: TuiPreferencesListState,
): string {
    if (state.preferences.length === 0) {
        return "No durable preferences. Answer an approval with 4 to add one.";
    }
    return state.preferences
        .map((preference, index) =>
            `${index === state.selectedIndex ? ">" : " "} ${
                formatPreferencePredicate(preference.when)
            }`
        )
        .join("\n");
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
        content: "[↑↓] move · [del] remove · [esc] close",
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
        position: "absolute",
        top: 2,
        left: "10%",
        width: "80%",
        height: "auto",
        maxHeight: "90%",
        zIndex: 20,
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
        visible: false,
    });
    box.add(dialogHeaderNode(renderer, "Durable permission preferences"));
    box.add(rows);
    box.add(footer);

    let current: BoxRenderable[] = [];
    return {
        box,
        update(state): void {
            for (const row of current) {
                row.destroy();
            }
            current = [];
            if (state.preferences.length === 0) {
                const empty = dialogOptionRow(renderer, {
                    label: "No durable preferences yet",
                    description: "answer an approval with 4 to add one",
                    active: false,
                });
                rows.add(empty);
                current.push(empty);
                return;
            }
            for (const { index, preference } of visibleRows(state)) {
                const row = dialogOptionRow(renderer, {
                    label: formatPreferencePredicate(preference.when),
                    active: index === state.selectedIndex,
                    leading: index === state.selectedIndex ? "> " : "  ",
                });
                rows.add(row);
                current.push(row);
            }
        },
    };
}

/** A preference paired with its real index, which the highlight compares against. */
interface NumberedPreference {
    readonly index: number;
    readonly preference: PermissionPreference;
}

/**
 * Windows the list around the cursor so a long list cannot push the footer off
 * a short terminal. Indices are carried alongside because after slicing, array
 * position no longer matches position in `state.preferences`.
 */
function visibleRows(
    state: TuiPreferencesListState,
): readonly NumberedPreference[] {
    const entries = state.preferences.map((preference, index) => ({
        index,
        preference,
    }));
    if (entries.length <= MAX_ROWS) {
        return entries;
    }
    const start = Math.max(
        0,
        Math.min(
            state.selectedIndex - Math.floor(MAX_ROWS / 2),
            entries.length - MAX_ROWS,
        ),
    );
    return entries.slice(start, start + MAX_ROWS);
}

/**
 * Shows the predicate rather than the ID. The ID is a UUID, so it identifies
 * nothing to a reader, while the predicate is the thing the user actually
 * agreed to. Removal targets the highlighted row, so no ID ever needs typing.
 */
function formatPreferencePredicate(predicate: PermissionPredicate): string {
    return Object.entries(predicate)
        .map(([field, value]) => `${field}=${String(value)}`)
        .join(", ");
}
