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
    dialogActionRow,
    dialogFooterNode,
    dialogHeaderNode,
    dialogOptionRows,
    dialogRowPointer,
    updateDialogSearchNode,
    type DialogRowPointer,
} from "./dialog-chrome.ts";
import { isTuiDialTabKey } from "./keymap.ts";
import { steppedSection } from "./section-keys.ts";
import { TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";
import { mixHex } from "./theme.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

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
    /** Models the resting list or the search left out, reachable through Browse. */
    readonly hidden?: number;
    readonly selectedIndex: number;
    readonly query: string;
    readonly queryCursor: number;
    readonly current?: string;
    readonly recents: readonly string[];
    readonly notice?: string;
    /** The favorite change the notice is waiting on, cleared when it lands. */
    readonly pending?: TuiModelSwitcherPending;
    /** Which section the keys belong to. The browse row is a stop inside the list. */
    readonly focus?: TuiModelSwitcherFocus;
}

export type TuiModelSwitcherFocus = "search" | "list";

/** The three stops Tab and the horizontal arrows walk. */
export type TuiModelSwitcherStop = "search" | "list" | "browse";

export interface TuiModelSwitcherPending {
    readonly key: string;
    readonly favorite: boolean;
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
    readonly browse?: true;
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
    const ordered = orderedRows(allRows, recents, "", context.current);
    return {
        allRows,
        recents,
        ...(context.current === undefined ? {} : { current: context.current }),
        ...(context.notice === undefined ? {} : { notice: context.notice }),
        ...ordered,
        selectedIndex: startingIndex(ordered.rows, context.current),
        query: "",
        queryCursor: 0,
        focus: "search",
    };
}

/** Rebuilds the list in place, so a favorite toggle moves the row without losing it. */
export function refreshedTuiModelSwitcher(
    state: TuiModelSwitcherState,
    allRows: readonly TuiModelSwitcherRow[],
    recents: readonly string[],
    notice?: string,
    pending?: TuiModelSwitcherPending,
): TuiModelSwitcherState {
    const held = state.rows[state.selectedIndex];
    const ordered = orderedRows(allRows, recents, state.query, state.current);
    const at = held === undefined ? -1 : ordered.rows
        .findIndex((row) => modelSwitcherKey(row) === modelSwitcherKey(held));
    const { notice: _notice, pending: _pending, ...carried } = state;
    return {
        ...carried,
        allRows,
        recents,
        ...ordered,
        selectedIndex: at >= 0
            ? at
            : onSwitcherBrowseRow(state)
            ? ordered.rows.length
            : Math.min(state.selectedIndex, Math.max(0, ordered.rows.length - 1)),
        ...(notice === undefined
            ? settledNotice(state, allRows)
            : { notice, ...(pending === undefined ? {} : { pending }) }),
    };
}

/** A pending notice stands until the snapshot shows the change it announced. */
function settledNotice(
    state: TuiModelSwitcherState,
    allRows: readonly TuiModelSwitcherRow[],
): Pick<TuiModelSwitcherState, "notice" | "pending"> {
    const { notice, pending } = state;
    if (notice === undefined) return {};
    if (pending === undefined) return { notice };
    const row = allRows.find((candidate) =>
        modelSwitcherKey(candidate) === pending.key
    );
    return row !== undefined && (row.favorite === true) === pending.favorite
        ? {}
        : { notice, pending };
}

function startingIndex(
    rows: readonly TuiModelSwitcherRow[],
    current: string | undefined,
): number {
    if (current === undefined) return 0;
    const at = rows.findIndex((row) => modelSwitcherKey(row) === current);
    return at >= 0 ? at : 0;
}

/** How many models the resting list shows before Browse models takes over. Favorites are never cut. */
export const MODEL_SWITCHER_SHORTLIST = 20;

/** How many matches a search shows before it points at Browse models. */
export const MODEL_SWITCHER_MATCHES = 20;

/**
 * At rest the switcher answers "which model now?" with a handful: the current
 * model, your favorites, then what you used last. With no favorites it lists
 * nothing and says how to get some. Everything else is a search away.
 */
function orderedRows(
    allRows: readonly TuiModelSwitcherRow[],
    recents: readonly string[],
    query: string,
    current?: string,
): {
    readonly rows: readonly TuiModelSwitcherRow[];
    readonly hidden: number;
} {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length > 0) {
        const matched = allRows
            .filter((row) => terms.every((term) => searchable(row).includes(term)))
            .toSorted((left, right) => searchRank(right, terms) - searchRank(left, terms));
        const shown = matched.slice(0, MODEL_SWITCHER_MATCHES);
        return { rows: shown, hidden: matched.length - shown.length };
    }
    const rows: TuiModelSwitcherRow[] = [];
    const taken = new Set<string>();
    const take = (row: TuiModelSwitcherRow | undefined, always = false): void => {
        if (row === undefined || taken.has(modelSwitcherKey(row))) return;
        if (!always && rows.length >= MODEL_SWITCHER_SHORTLIST) return;
        taken.add(modelSwitcherKey(row));
        rows.push(row);
    };
    const find = (key: string): TuiModelSwitcherRow | undefined =>
        allRows.find((candidate) => modelSwitcherKey(candidate) === key);
    if (!allRows.some((row) => row.favorite === true)) {
        return { rows, hidden: allRows.length };
    }
    if (current !== undefined) take(find(current), true);
    for (const row of allRows) if (row.favorite === true) take(row, true);
    for (const key of recents) take(find(key));
    return { rows, hidden: allRows.length - rows.length };
}

function searchable(row: TuiModelSwitcherRow): string {
    return `${row.label} ${row.provider} ${row.model}`.toLowerCase();
}

function searchRank(row: TuiModelSwitcherRow, terms: readonly string[]): number {
    const label = row.label.toLowerCase();
    const prefix = terms.every((term) => label.startsWith(term)) ? 4 : 0;
    const inLabel = terms.every((term) => label.includes(term)) ? 2 : 0;
    return prefix + inLabel
        + (row.favorite === true ? 1 : 0);
}

/** The row pinned under the list, which leaves for the page `/models` opens. */
export const MODEL_SWITCHER_BROWSE_LABEL = "Browse models";

/** One press of pageup, pagedown, Ctrl+U or Ctrl+D covers this many rows. */
const PAGE_ROWS = 10;

export function handleTuiModelSwitcherKey(
    state: TuiModelSwitcherState,
    key: TuiModelSwitcherKey,
): TuiModelSwitcherTransition {
    if (isTuiDialTabKey(key) && !key.ctrl && !key.meta) {
        const forward = key.shift !== true && key.name !== "backtab";
        return { state: steppedSwitcherSection(state, forward), handled: true };
    }
    const selected = state.rows[state.selectedIndex];
    if (key.ctrl === true && key.name === "f") {
        return selected === undefined
            ? { state, handled: true }
            : { state, favorite: selected, handled: true };
    }
    if (key.ctrl === true && key.name === "k") {
        return { browse: true, handled: true };
    }
    if (key.ctrl === true && key.name === "u") return moved(state, -PAGE_ROWS);
    if (key.ctrl === true && key.name === "d") return moved(state, PAGE_ROWS);
    if (key.ctrl === true || key.meta === true || key.super === true
        || key.hyper === true || key.shift === true) {
        return { state, handled: false };
    }
    if (key.name === "escape") return { handled: true };
    // The editor moves the caret first, so a horizontal arrow arriving from
    // Search is at an edge and stays put.
    if (key.name === "left" || key.name === "right") {
        return switcherFocus(state) === "search"
            ? { state, handled: true }
            : { state: steppedSwitcherSection(state, key.name === "right"), handled: true };
    }
    if (key.name === "up") return moved(state, -1);
    if (key.name === "down") return moved(state, 1);
    if (key.name === "pageup") return moved(state, -PAGE_ROWS);
    if (key.name === "pagedown") return moved(state, PAGE_ROWS);
    if (key.name === "home") return moved(state, -state.rows.length);
    if (key.name === "end") return moved(state, state.rows.length);
    if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
        if (state.allRows.length === 0) return { providers: true, handled: true };
        if (onSwitcherBrowseRow(state)) return { browse: true, handled: true };
        return selected === undefined
            ? { state, handled: true }
            : { selection: selected, handled: true };
    }
    return { state, handled: false };
}

/** The cursor reaches the browse row by sitting one past the last model. */
export function onSwitcherBrowseRow(state: TuiModelSwitcherState): boolean {
    return state.selectedIndex === state.rows.length;
}

export function switcherFocus(state: TuiModelSwitcherState): TuiModelSwitcherFocus {
    return state.focus ?? "search";
}

/** Search, the list, and the browse row, in the order Tab walks them. */
export function switcherStop(state: TuiModelSwitcherState): TuiModelSwitcherStop {
    if (switcherFocus(state) === "search") return "search";
    return onSwitcherBrowseRow(state) ? "browse" : "list";
}

function steppedSwitcherSection(
    state: TuiModelSwitcherState,
    forward: boolean,
): TuiModelSwitcherState {
    const stops: readonly TuiModelSwitcherStop[] = state.rows.length === 0
        ? ["search", "browse"]
        : ["search", "list", "browse"];
    return atSwitcherStop(state, steppedSection(stops, switcherStop(state), forward));
}

function atSwitcherStop(
    state: TuiModelSwitcherState,
    stop: TuiModelSwitcherStop,
): TuiModelSwitcherState {
    if (stop === "search") return { ...state, focus: "search" };
    if (stop === "browse") {
        return { ...state, focus: "list", selectedIndex: state.rows.length };
    }
    // Arriving from the browse row lands on the last model, not past it.
    return { ...state, focus: "list",
        selectedIndex: Math.min(state.selectedIndex, Math.max(0, state.rows.length - 1)) };
}

function moved(
    state: TuiModelSwitcherState,
    delta: number,
): TuiModelSwitcherTransition {
    const last = state.rows.length;
    return {
        state: {
            ...state,
            focus: "list",
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
    const selectedIndex = wheelCursor(state.selectedIndex, state.rows.length + 1, scroll);
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
}

/** Fewest columns the card takes before it falls back to the whole screen. */
const SWITCHER_MIN_WIDTH = 80;

/** The card is 60% of the screen, but never under SWITCHER_MIN_WIDTH unless the screen is narrower. */
function switcherCardWidth(renderer: RenderContext): number {
    return Math.min(renderer.width, Math.max(SWITCHER_MIN_WIDTH, Math.floor(renderer.width * 0.6)));
}

/** The rule spans the card less its padding. */
function switcherContentWidth(renderer: RenderContext): number {
    return Math.max(1, switcherCardWidth(renderer) - DIALOG_CARD_PADDING * 2);
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
        width: switcherCardWidth(renderer),
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
            // Outside Search the caret keys belong to the sections.
            if (
                switcherFocus(state) !== "search"
                && ["left", "right", "home", "end"].includes(key.name)
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
            box.width = switcherCardWidth(renderer);
            search.box.parent?.remove(search.box.id);
            for (const node of nodes) node.destroyRecursively();
            nodes = [];

            const header = dialogHeaderNode(
                renderer,
                "Switch model",
                "esc",
            );
            updateDialogSearchNode(
                search,
                state.query,
                "Search models",
                true,
                state.queryCursor,
            );
            box.add(header);
            const caption = new TextRenderable(renderer, {
                content: `${DIALOG_GUTTER}${switcherCaption(state)}`,
                fg: TUI_MUTED,
                width: "100%",
                height: 1,
            });
            box.add(caption);
            box.add(search.box);
            nodes.push(header);
            nodes.push(caption);

            const { display, above, below } = windowedRows(renderer, state);
            if (display.length === 0) {
                const message = emptyMessage(state);
                const resting = state.allRows.length > 0 && state.query.trim().length === 0;
                const indent = Math.max(
                    0,
                    Math.floor((switcherContentWidth(renderer) - message.length) / 2),
                );
                const empty = new TextRenderable(renderer, {
                    content: resting
                        ? `${" ".repeat(indent)}${message}`
                        : `${DIALOG_GUTTER}${message}`,
                    fg: TUI_MUTED,
                    width: "100%",
                    height: 1,
                    ...(resting ? { marginTop: 2, marginBottom: 1 } : {}),
                });
                box.add(empty);
                nodes.push(empty);
            }
            const scrollHint = (count: number, where: string): void => {
                const hint = new TextRenderable(renderer, {
                    content: count === 0 ? "" : `${DIALOG_GUTTER}${count} more ${where}`,
                    fg: TUI_MUTED,
                    width: "100%",
                    height: 1,
                });
                box.add(hint);
                nodes.push(hint);
            };
            const scrolling = above + below > 0;
            if (scrolling) scrollHint(above, "above");
            for (
                const node of dialogOptionRows(renderer, display.map((entry) => {
                    const meta = rowMeta(state, entry.row);
                    return {
                        label: switcherRowLabel(state, entry.row),
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
            if (scrolling) scrollHint(below, "below");

            // Buttons sit under a rule, in their own band, the way every other dialog draws them.
            const rule = new TextRenderable(renderer, {
                content: "\u2500".repeat(switcherContentWidth(renderer)),
                fg: mixHex(TUI_PANEL, TUI_TEXT, 0.30),
                width: "100%",
                height: 1,
                marginTop: 1,
                selectable: false,
            });
            box.add(rule);
            nodes.push(rule);
            const pointer = dialogRowPointer(view.pointer, state.rows.length);
            const browse = dialogActionRow(
                renderer, browseRowLabel(state), onSwitcherBrowseRow(state), false,
                pointer.onSelect, pointer.onHover, "Ctrl+K",
            );
            box.add(browse);
            nodes.push(browse);

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
    const stop = switcherStop(state);
    if (stop === "search" && state.rows.length === 0) {
        return "type search · ⏎ browse · esc close";
    }
    if (stop === "browse") {
        return "⏎ browse · ←→ sections · ↑↓ move · esc close";
    }
    const favorite = state.rows[state.selectedIndex]?.favorite === true
        ? "Ctrl+F unfavorite"
        : "Ctrl+F favorite";
    return stop === "search"
        ? `type search · ↓ list · ⏎ switch · ${favorite} · esc close`
        : `↑↓ move · ←→ sections · Ctrl+U/D page · ⏎ switch · ${favorite} · esc`;
}

export function switcherEmptyMessage(state: TuiModelSwitcherState): string {
    return emptyMessage(state);
}

function emptyMessage(state: TuiModelSwitcherState): string {
    if (state.allRows.length === 0) return "No models. ⏎ connects a provider.";
    return state.query.trim().length === 0
        ? "Type to pick any model, or favorite one to see favorites here."
        : "No models match that search. /models adds a provider.";
}

/** Two providers can serve one model under different spellings; the provider tells them apart. */
export function switcherRowLabel(
    state: TuiModelSwitcherState,
    row: TuiModelSwitcherRow,
): string {
    const name = comparableModelName(row.label);
    const shared = state.allRows.some((other) =>
        other.provider !== row.provider && comparableModelName(other.label) === name);
    return shared ? `${row.label} (${row.providerLabel ?? row.provider})` : row.label;
}

/** "OpenAI: GPT-5.6 Luna" and "GPT-5.6-Luna" compare equal. */
function comparableModelName(label: string): string {
    const vendor = label.indexOf(": ");
    const name = vendor === -1 ? label : label.slice(vendor + 2);
    return name.toLowerCase().replace(/[\s_-]+/g, "");
}

/** The bar marks the cursor, so the check has to mark the current model on its own. */
function rowMeta(
    state: TuiModelSwitcherState,
    row: TuiModelSwitcherRow,
): string | undefined {
    const parts = [
        ...(row.effort === undefined ? [] : [row.effort]),
        ...(row.unavailable === true ? ["unavailable"] : []),
        ...(modelSwitcherKey(row) === state.current ? ["✓"] : []),
    ];
    return parts.length === 0 ? undefined : parts.join(" · ");
}

/** Says what the list in front of you is, so the short list does not read as the whole catalog. */
export function switcherCaption(state: TuiModelSwitcherState): string {
    return state.query.trim().length === 0
        ? "Your model, your favorites, then what you used last."
        : "Every connected model, closest match first.";
}

/** A search that reached its limit says where the rest of the matches are. */
export function browseRowLabel(state: TuiModelSwitcherState): string {
    const hidden = state.query.trim().length === 0 ? 0 : state.hidden ?? 0;
    return hidden === 0
        ? MODEL_SWITCHER_BROWSE_LABEL
        : `${MODEL_SWITCHER_BROWSE_LABEL} · ${hidden} more ${hidden === 1 ? "match" : "matches"}`;
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
        return { state: { ...state, queryCursor, focus: "search" }, handled: true };
    }
    const ordered = orderedRows(state.allRows, state.recents, query, state.current);
    return {
        state: { ...state, ...ordered, query, queryCursor, selectedIndex: 0, focus: "search" },
        handled: true,
    };
}

function displayRows(
    window: readonly TuiModelSwitcherRow[],
    offset: number,
): readonly SwitcherDisplayRow[] {
    return window.map((row, position) => ({ row, index: offset + position }));
}

interface SwitcherWindow {
    readonly display: readonly SwitcherDisplayRow[];
    readonly above: number;
    readonly below: number;
}

function windowedRows(
    renderer: RenderContext,
    state: TuiModelSwitcherState,
): SwitcherWindow {
    if (state.rows.length === 0) return { display: [], above: 0, below: 0 };
    const fits = switcherMaxRows(renderer);
    // An overflowing list gives up two rows to the "more above" and "more below" lines.
    const maxRows = state.rows.length <= fits ? fits : Math.max(1, fits - 2);
    const window = listWindowSlice(
        state.rows,
        Math.min(state.selectedIndex, state.rows.length - 1),
        maxRows,
    );
    const start = Math.max(0, state.rows.indexOf(window[0]!));
    return {
        display: displayRows(window, start),
        above: start,
        below: state.rows.length - start - window.length,
    };
}

function switcherMaxRows(renderer: RenderContext): number {
    return listWindowRows(
        dialogBoxHeight(renderer, renderer.height / 8),
        DIALOG_CHROME_HEIGHT - DIALOG_SEARCH_HEIGHT + dialogSearchHeight(renderer),
    );
}
