/**
 * The two removable permission tiers, made visible and removable.
 *
 * Session grants and durable preferences share one overlay because they share
 * one act: reviewing what you have already agreed to and taking some of it back.
 * They stay visibly separate sections because they do not share a lifetime, and
 * a user deciding whether to revoke something needs to know whether it expires
 * on its own. Permission modes are not here: a mode is a declarative substrate
 * you switch, not a list of accumulated allowances you prune.
 *
 * Deliberately a separate overlay from the settings picker rather than a sixth
 * picker kind. The picker swallows every single-character key into its search
 * query (`handleTuiSettingsPickerKey`), which is why session trash is bound to
 * `delete` and not to `d`. A short list of allowances wants plain keys and has
 * nothing to search, while a fifty-entry model list needs the filter, so the two
 * do not fit one component. The picker's flat homogeneous `state.options` is the
 * second reason: these rows are two kinds under one cursor.
 */

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
import { dialogHeaderNode, dialogOptionRow } from "./dialog-chrome.ts";

/** Rows shown at once before the list windows around the cursor. */
const MAX_ROWS = 10;

/**
 * Which store a row came from, which the client needs because the two tiers take
 * different removal commands: a grant lives in the session log, a preference in
 * a file in the home directory.
 */
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
    /** Absent means the overlay closed. */
    readonly state?: TuiPreferencesListState;
    /** Set when the user asked to remove the highlighted entry. */
    readonly remove?: TuiPermissionEntry;
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
    return { entries: entriesFrom(inspection), selectedIndex: 0 };
}

/**
 * Folds a refreshed inspection into an open overlay, which is how a removal
 * becomes visible: the engine replies with a full inspection rather than an
 * acknowledgement, so the list is never reconstructed client-side. The cursor is
 * clamped because the list it pointed into just got shorter.
 */
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
    if (key.name === "delete" || key.name === "backspace") {
        const selected = state.entries[state.selectedIndex];
        // No confirmation step, unlike session trash. Removing either kind can
        // only make Vera ask more often: it restores a prompt the user had
        // silenced, so the destructive direction here is the safe one.
        return selected === undefined
            ? { state, handled: true }
            : { state, remove: selected, handled: true };
    }
    return { state, handled: false };
}

/** Plain-text form, used for the notice fallback and by tests. */
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
    box.add(dialogHeaderNode(renderer, "Granted permissions"));
    box.add(rows);
    box.add(footer);

    let current: (BoxRenderable | TextRenderable)[] = [];
    return {
        box,
        update(state): void {
            for (const row of current) {
                row.destroy();
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
            for (const { index, entry } of visibleRows(state)) {
                if (entry.kind !== group) {
                    group = entry.kind;
                    // A header, not a row: `visibleRows` windows over entries
                    // only, so the cursor can never land here.
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
                    label: formatPredicate(entry.when),
                    active: index === state.selectedIndex,
                    leading: index === state.selectedIndex ? "> " : "  ",
                });
                rows.add(row);
                current.push(row);
            }
        },
    };
}

/** An entry paired with its real index, which the highlight compares against. */
interface NumberedEntry {
    readonly index: number;
    readonly entry: TuiPermissionEntry;
}

/**
 * Grants first, because they are the shorter-lived half and the ones a user is
 * most likely to have just created. Order is stable so the cursor does not move
 * under a removal of the other kind.
 */
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

/**
 * Windows the list around the cursor so a long list cannot push the footer off a
 * short terminal. Indices are carried alongside because after slicing, array
 * position no longer matches position in `state.entries`.
 */
function visibleRows(
    state: TuiPreferencesListState,
): readonly NumberedEntry[] {
    const entries = state.entries.map((entry, index) => ({ index, entry }));
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
 * Shows the predicate rather than the ID. The ID is opaque, so it identifies
 * nothing to a reader, while the predicate is the thing the user actually agreed
 * to. Removal targets the highlighted row, so no ID ever needs typing.
 */
function formatPredicate(predicate: PermissionPredicate): string {
    return Object.entries(predicate)
        .map(([field, value]) => `${field}=${String(value)}`)
        .join(", ");
}
