import {
    BoxRenderable,
    TextRenderable,
    type Renderable,
    type RenderContext,
} from "@opentui/core";

import { DIALOG_SEARCH_HEIGHT, dialogSearchHeight } from "./dialog-search.ts";
import {
    dialogBoxHeight,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import {
    DIALOG_CARD_PADDING,
    DIALOG_CHROME_HEIGHT,
    DIALOG_GUTTER,
    centeredDialogSurface,
    createDialogSearchNode,
    dialogFooterNode,
    dialogHeaderNode,
    dialogOptionRows,
    dialogRowPointer,
    updateDialogSearchNode,
    type DialogRowPointer,
} from "./dialog-chrome.ts";
import { isTuiDialTabKey } from "./keymap.ts";
import { TUI_MUTED, TUI_PANEL } from "./state.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

export const FAVORITES_GROUP = "Favorites";
export const RECENT_GROUP = "Recent";

export interface TuiModelSwitcherRow {
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    readonly providerLabel?: string;
    readonly favorite?: boolean;
    readonly unavailable?: boolean;
    /** The effort this model last ran with, so the row says what Enter will do. */
    readonly effort?: string;
}

export interface TuiModelSwitcherState {
    readonly allRows: readonly TuiModelSwitcherRow[];
    readonly rows: readonly TuiModelSwitcherRow[];
    /** One per visible row, parallel to `rows`. Empty while searching. */
    readonly groups: readonly string[];
    readonly selectedIndex: number;
    readonly query: string;
    readonly queryCursor: number;
    readonly current?: string;
    readonly recents: readonly string[];
    readonly notice?: string;
}

export interface TuiModelSwitcherKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
    readonly shift?: boolean;
}

export interface TuiModelSwitcherTransition {
    readonly state?: TuiModelSwitcherState;
    readonly selection?: TuiModelSwitcherRow;
    readonly favorite?: TuiModelSwitcherRow;
    readonly providers?: true;
    readonly handled: boolean;
}

export function modelSwitcherKey(
    row: { readonly provider: string; readonly model: string },
): string {
    return `${row.provider}/${row.model}`;
}

export function startTuiModelSwitcher(
    allRows: readonly TuiModelSwitcherRow[],
    context: {
        readonly current?: string;
        readonly recents?: readonly string[];
        readonly notice?: string;
    } = {},
): TuiModelSwitcherState {
    const recents = context.recents ?? [];
    const ordered = orderedRows(allRows, recents, "");
    return {
        allRows,
        recents,
        ...(context.current === undefined ? {} : { current: context.current }),
        ...(context.notice === undefined ? {} : { notice: context.notice }),
        ...ordered,
        selectedIndex: startingIndex(ordered.rows, context.current),
        query: "",
        queryCursor: 0,
    };
}

/** Rebuilds the list in place, so a favorite toggle moves the row without losing it. */
export function refreshedTuiModelSwitcher(
    state: TuiModelSwitcherState,
    allRows: readonly TuiModelSwitcherRow[],
    notice?: string,
): TuiModelSwitcherState {
    const held = state.rows[state.selectedIndex];
    const ordered = orderedRows(allRows, state.recents, state.query);
    const at = held === undefined ? -1 : ordered.rows
        .findIndex((row) => modelSwitcherKey(row) === modelSwitcherKey(held));
    return {
        ...state,
        allRows,
        ...ordered,
        selectedIndex: at >= 0
            ? at
            : Math.min(state.selectedIndex, Math.max(0, ordered.rows.length - 1)),
        ...(notice === undefined ? {} : { notice }),
    };
}

function startingIndex(
    rows: readonly TuiModelSwitcherRow[],
    current: string | undefined,
): number {
    if (current === undefined) return 0;
    const at = rows.findIndex((row) => modelSwitcherKey(row) === current);
    return at >= 0 ? at : 0;
}

/**
 * Favorites, then recents, then every connected provider. Typing drops the
 * grouping: a search that spans providers cannot also be grouped by one.
 */
function orderedRows(
    allRows: readonly TuiModelSwitcherRow[],
    recents: readonly string[],
    query: string,
): {
    readonly rows: readonly TuiModelSwitcherRow[];
    readonly groups: readonly string[];
} {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length > 0) {
        const matched = allRows
            .filter((row) => terms.every((term) => searchable(row).includes(term)))
            .toSorted((left, right) => searchRank(right, terms) - searchRank(left, terms));
        return { rows: matched, groups: matched.map(() => "") };
    }
    const rows: TuiModelSwitcherRow[] = [];
    const groups: string[] = [];
    const taken = new Set<string>();
    const take = (row: TuiModelSwitcherRow, group: string): void => {
        taken.add(modelSwitcherKey(row));
        rows.push(row);
        groups.push(group);
    };
    for (const row of allRows) {
        if (row.favorite === true) take(row, FAVORITES_GROUP);
    }
    for (const key of recents) {
        const row = allRows.find((candidate) => modelSwitcherKey(candidate) === key);
        if (row !== undefined && !taken.has(key)) take(row, RECENT_GROUP);
    }
    for (const row of allRows) {
        if (!taken.has(modelSwitcherKey(row))) {
            take(row, row.providerLabel ?? row.provider);
        }
    }
    return { rows, groups };
}

function searchable(row: TuiModelSwitcherRow): string {
    return `${row.label} ${row.provider} ${row.model}`.toLowerCase();
}

function searchRank(row: TuiModelSwitcherRow, terms: readonly string[]): number {
    const label = row.label.toLowerCase();
    const prefix = terms.every((term) => label.startsWith(term)) ? 4 : 0;
    const inLabel = terms.every((term) => label.includes(term)) ? 2 : 0;
    return prefix + inLabel + (row.favorite === true ? 1 : 0);
}

export function handleTuiModelSwitcherKey(
    state: TuiModelSwitcherState,
    key: TuiModelSwitcherKey,
): TuiModelSwitcherTransition {
    if (isTuiDialTabKey(key) && !key.ctrl && !key.meta) {
        return { state, handled: true };
    }
    const selected = state.rows[state.selectedIndex];
    if (key.ctrl === true && key.name === "f") {
        return selected === undefined
            ? { state, handled: true }
            : { state, favorite: selected, handled: true };
    }
    if (key.ctrl === true || key.meta === true || key.super === true
        || key.hyper === true || key.shift === true) {
        return { state, handled: false };
    }
    if (key.name === "escape") return { handled: true };
    if (key.name === "up") return moved(state, -1);
    if (key.name === "down") return moved(state, 1);
    if (key.name === "pageup") return moved(state, -10);
    if (key.name === "pagedown") return moved(state, 10);
    if (key.name === "home") return moved(state, -state.rows.length);
    if (key.name === "end") return moved(state, state.rows.length);
    if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
        if (selected !== undefined) return { selection: selected, handled: true };
        return state.allRows.length === 0
            ? { providers: true, handled: true }
            : { state, handled: true };
    }
    return { state, handled: false };
}

function moved(
    state: TuiModelSwitcherState,
    delta: number,
): TuiModelSwitcherTransition {
    const last = Math.max(0, state.rows.length - 1);
    return {
        state: {
            ...state,
            selectedIndex: Math.max(0, Math.min(last, state.selectedIndex + delta)),
        },
        handled: true,
    };
}

export function handleTuiModelSwitcherScroll(
    state: TuiModelSwitcherState,
    scroll: {
        readonly direction: "up" | "down" | "left" | "right";
        readonly delta: number;
    },
): TuiModelSwitcherTransition {
    const selectedIndex = wheelCursor(state.selectedIndex, state.rows.length, scroll);
    return selectedIndex === undefined
        ? { state, handled: false }
        : { state: { ...state, selectedIndex }, handled: true };
}

export interface TuiModelSwitcherView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    pointer?: DialogRowPointer;
    focus(): void;
    handleEditorKey(
        state: TuiModelSwitcherState,
        key: TuiModelSwitcherKey,
    ): TuiModelSwitcherTransition;
    handleEditorPaste(
        state: TuiModelSwitcherState,
        text: string,
    ): TuiModelSwitcherState;
    update(state: TuiModelSwitcherState): void;
}

interface SwitcherDisplayRow {
    readonly row: TuiModelSwitcherRow;
    readonly index: number;
    readonly heading?: string;
    readonly spaced: boolean;
}

export function createTuiModelSwitcherView(
    renderer: RenderContext,
): TuiModelSwitcherView {
    let nodes: Renderable[] = [];
    const search = createDialogSearchNode(renderer, "model-switcher-search");
    const box = new BoxRenderable(renderer, {
        id: "model-switcher",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "60%",
        height: 8,
        paddingLeft: DIALOG_CARD_PADDING,
        paddingRight: DIALOG_CARD_PADDING,
        paddingTop: 2,
        paddingBottom: 1,
        focusable: true,
    });
    const surface = centeredDialogSurface(renderer, "model-switcher-surface", box);

    const view: TuiModelSwitcherView = {
        box,
        surface,
        focus(): void {
            search.editor.focus();
        },
        handleEditorKey(state, key): TuiModelSwitcherTransition {
            if (
                key.ctrl === true || key.meta === true
                || key.name === "escape" || key.name === "up"
                || key.name === "down" || key.name === "return"
                || key.name === "enter" || key.name === "kpenter"
                || key.name === "pageup" || key.name === "pagedown"
            ) {
                return { state, handled: false };
            }
            const handled = search.editor.handleKeyPress(tuiTextareaKey(key));
            return handled
                ? searched(state, search.editor.plainText, search.editor.cursorOffset)
                : { state, handled: false };
        },
        handleEditorPaste(state, text): TuiModelSwitcherState {
            insertTuiSingleLinePaste(search.editor, text);
            return searched(
                state,
                search.editor.plainText,
                search.editor.cursorOffset,
            ).state ?? state;
        },
        update(state): void {
            search.box.parent?.remove(search.box.id);
            for (const node of nodes) node.destroyRecursively();
            nodes = [];

            const header = dialogHeaderNode(
                renderer,
                "Switch model",
                `${counter(state)} · esc`,
            );
            updateDialogSearchNode(
                search,
                state.query,
                "Search models",
                true,
                state.queryCursor,
            );
            box.add(header);
            box.add(search.box);
            nodes.push(header);

            const display = windowedRows(renderer, state);
            if (display.length === 0) {
                const empty = new TextRenderable(renderer, {
                    content: `${DIALOG_GUTTER}${emptyMessage(state)}`,
                    fg: TUI_MUTED,
                    width: "100%",
                    height: 1,
                });
                box.add(empty);
                nodes.push(empty);
            }
            for (
                const node of dialogOptionRows(renderer, display.map((entry) => {
                    const meta = rowMeta(state, entry.row);
                    return {
                        label: entry.row.label,
                        ...(entry.heading === undefined
                            ? {}
                            : { leading: entry.heading, leadingTone: "muted" as const }),
                        spaced: entry.spaced,
                        ...(meta === undefined ? {} : { meta }),
                        active: entry.index === state.selectedIndex,
                        current: modelSwitcherKey(entry.row) === state.current,
                        ...dialogRowPointer(view.pointer, entry.index),
                    };
                }))
            ) {
                box.add(node);
                nodes.push(node);
            }

            if (state.notice !== undefined) {
                const notice = new TextRenderable(renderer, {
                    content: `${DIALOG_GUTTER}${state.notice}`,
                    fg: TUI_MUTED,
                    width: "100%",
                    height: 1,
                });
                box.add(notice);
                nodes.push(notice);
            }
            const footer = dialogFooterNode(renderer, footerText(state));
            box.add(footer);
            nodes.push(footer);
            box.height = "auto";
        },
    };
    return view;
}

export function switcherFooterText(state: TuiModelSwitcherState): string {
    return footerText(state);
}

function footerText(state: TuiModelSwitcherState): string {
    const favorite = state.rows[state.selectedIndex]?.favorite === true
        ? "^f unfavorite"
        : "^f favorite";
    return `↑↓ move · ⏎ switch · ${favorite} · esc close`;
}

export function switcherEmptyMessage(state: TuiModelSwitcherState): string {
    return emptyMessage(state);
}

function emptyMessage(state: TuiModelSwitcherState): string {
    return state.allRows.length === 0
        ? "No models. ⏎ connects a provider."
        : "No models match that search.";
}

/** Bold alone marks the current row, so the word goes in the meta column too. */
function rowMeta(
    state: TuiModelSwitcherState,
    row: TuiModelSwitcherRow,
): string | undefined {
    const parts = [
        ...(state.query.length > 0 ? [row.providerLabel ?? row.provider] : []),
        ...(row.effort === undefined ? [] : [row.effort]),
        ...(row.unavailable === true ? ["unavailable"] : []),
        ...(modelSwitcherKey(row) === state.current ? ["current"] : []),
    ];
    return parts.length === 0 ? undefined : parts.join(" · ");
}

function counter(state: TuiModelSwitcherState): string {
    return state.rows.length === 0
        ? "0"
        : `${state.selectedIndex + 1}/${state.rows.length}`;
}

export function searchedTuiModelSwitcher(
    state: TuiModelSwitcherState,
    query: string,
): TuiModelSwitcherState {
    return searched(state, query, query.length).state ?? state;
}

function searched(
    state: TuiModelSwitcherState,
    query: string,
    queryCursor: number,
): TuiModelSwitcherTransition {
    if (query === state.query) {
        return { state: { ...state, queryCursor }, handled: true };
    }
    const ordered = orderedRows(state.allRows, state.recents, query);
    return {
        state: { ...state, ...ordered, query, queryCursor, selectedIndex: 0 },
        handled: true,
    };
}

function displayRows(
    state: TuiModelSwitcherState,
    window: readonly TuiModelSwitcherRow[],
    offset: number,
): readonly SwitcherDisplayRow[] {
    const width = Math.max(0, ...state.groups.map((group) => group.length)) + 2;
    return window.map((row, position) => {
        const index = offset + position;
        const group = state.groups[index] ?? "";
        const first = state.groups[index - 1] !== group;
        return {
            row,
            index,
            ...(group.length === 0
                ? {}
                : { heading: (first ? group.toLowerCase() : "").padEnd(width) }),
            spaced: first && position > 0 && group.length > 0,
        };
    });
}

function windowedRows(
    renderer: RenderContext,
    state: TuiModelSwitcherState,
): readonly SwitcherDisplayRow[] {
    if (state.rows.length === 0) return [];
    const window = listWindowSlice(
        state.rows,
        state.selectedIndex,
        switcherMaxRows(renderer),
    );
    return displayRows(state, window, Math.max(0, state.rows.indexOf(window[0]!)));
}

function switcherMaxRows(renderer: RenderContext): number {
    return listWindowRows(
        dialogBoxHeight(renderer, renderer.height / 4),
        DIALOG_CHROME_HEIGHT - DIALOG_SEARCH_HEIGHT + dialogSearchHeight(renderer),
    );
}
