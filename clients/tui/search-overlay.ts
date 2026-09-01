import type { LinesViewState } from "./lines-view.ts";
import { tuiBindingId } from "./keymap.ts";
import { relativeTime } from "../../src/relative-time.ts";
import type {
    SessionSearchFilter,
    SessionSearchHit,
    SessionSearchQuery,
    SessionSearchResults,
} from "../../src/store/session-search.ts";

/** The search overlay's presentation model, with no OpenTUI in it. Same division as the Work tab: what is on screen, what the keys do, and what enter opens are all decidable as. */

export const SEARCH_NARROW_WIDTH = 64;

export const SEARCH_PAGE = 5;

export const SEARCH_FILTERS: readonly (SessionSearchFilter | undefined)[] = [
    undefined,
    "messages",
    "tools",
    "files",
];

export type SearchScope = "conversation" | "workspace" | "everywhere";

const SEARCH_SCOPES: readonly SearchScope[] = [
    "conversation",
    "workspace",
    "everywhere",
];

export interface SearchOverlayState {
    readonly query: string;
    readonly queryCursor: number;
    readonly filter?: SessionSearchFilter;
    readonly scope: SearchScope;
    readonly workspace: string;
    readonly sessionId?: string;
    readonly results?: SessionSearchResults;
    readonly notice?: string;
    readonly searching: boolean;
    readonly selected?: SearchSelection;
}

export interface SearchSelection {
    readonly sessionId: string;
    readonly hitIndex: number;
}

export interface SearchOverlayStart {
    readonly sessionId?: string;
    readonly scope?: SearchScope;
}

export function startSearchOverlay(
    workspace: string,
    start: SearchOverlayStart = {},
): SearchOverlayState {
    const scopes = availableScopes(start.sessionId);
    const scope = start.scope !== undefined && scopes.includes(start.scope)
        ? start.scope
        : scopes[0]!;
    return {
        query: "",
        queryCursor: 0,
        scope,
        workspace,
        ...(start.sessionId === undefined ? {} : { sessionId: start.sessionId }),
        searching: false,
    };
}

function availableScopes(sessionId?: string): readonly SearchScope[] {
    return sessionId === undefined
        ? SEARCH_SCOPES.filter((scope) => scope !== "conversation")
        : SEARCH_SCOPES;
}

export function searchOverlayQuery(
    state: SearchOverlayState,
): SessionSearchQuery | undefined {
    const query = state.query.trim();
    if (query.length === 0) return undefined;
    return {
        query,
        ...(state.filter === undefined ? {} : { kind: state.filter }),
        ...(state.scope === "workspace" ? { workspace: state.workspace } : {}),
        ...(state.scope === "conversation" && state.sessionId !== undefined
            ? { session_id: state.sessionId }
            : {}),
    };
}

export type SearchOverlayAction =
    | { readonly kind: "search"; readonly query: SessionSearchQuery }
    | { readonly kind: "close" }
    | {
        readonly kind: "open";
        readonly session_id: string;
        readonly session_path: string;
        readonly entry_id: string | null;
    };

export interface SearchOverlayTransition {
    readonly state?: SearchOverlayState;
    readonly action?: SearchOverlayAction;
    readonly handled: boolean;
}

export interface SearchOverlayKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly sequence?: string;
}

export function handleSearchOverlayKey(
    state: SearchOverlayState,
    key: SearchOverlayKey,
): SearchOverlayTransition {
    const binding = tuiBindingId("search", key);
    if (binding === "cycle_search_filter") {
        return requery({ ...state, filter: nextFilter(state.filter) });
    }
    if (binding === "toggle_search_scope") {
        return requery({ ...state, scope: widerScope(state) });
    }
    if (binding === "half_page_down" || binding === "half_page_up") {
        const selected = moveSearchSelection(
            state,
            binding === "half_page_up" ? -SEARCH_PAGE : SEARCH_PAGE,
        );
        return {
            state: selected === undefined ? state : { ...state, selected },
            handled: true,
        };
    }
    if (key.ctrl || key.meta) return { state, handled: false };
    if (key.name === "escape") {
        return { action: { kind: "close" }, handled: true };
    }
    if (key.name === "return" || key.name === "enter") {
        const opened = openSelected(state);
        return opened === undefined
            ? { state, handled: true }
            : { action: opened, handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        const selected = moveSearchSelection(
            state,
            key.name === "up" ? -1 : 1,
        );
        return {
            state: selected === undefined ? state : { ...state, selected },
            handled: true,
        };
    }
    return { state, handled: false };
}

export function updateSearchOverlayText(
    state: SearchOverlayState,
    query: string,
    cursor = query.length,
): SearchOverlayTransition {
    return requery(typed(state, { value: query, cursor }));
}

function typed(
    state: SearchOverlayState,
    editor: { readonly value: string; readonly cursor: number },
): SearchOverlayState {
    const query = editor.value;
    const searching = query.trim().length > 0;
    const next: SearchOverlayState = {
        query: query,
        queryCursor: editor.cursor,
        scope: state.scope,
        workspace: state.workspace,
        searching,
        ...(state.sessionId === undefined
            ? {}
            : { sessionId: state.sessionId }),
        ...(state.filter === undefined ? {} : { filter: state.filter }),
        ...(searching && state.results !== undefined
            ? { results: state.results, ...(state.selected === undefined
                ? {}
                : { selected: state.selected }) }
            : {}),
    };
    return next;
}

function requery(state: SearchOverlayState): SearchOverlayTransition {
    const query = searchOverlayQuery(state);
    const next: SearchOverlayState = {
        ...state,
        searching: query !== undefined,
        ...(query === undefined ? { results: undefined } : {}),
    };
    return query === undefined
        ? { state: next, handled: true }
        : { state: next, action: { kind: "search", query }, handled: true };
}

function nextFilter(
    filter: SessionSearchFilter | undefined,
): SessionSearchFilter | undefined {
    const at = SEARCH_FILTERS.indexOf(filter);
    return SEARCH_FILTERS[(at + 1) % SEARCH_FILTERS.length];
}

export function applySearchResults(
    state: SearchOverlayState,
    query: SessionSearchQuery,
    results: SessionSearchResults,
): SearchOverlayState {
    const current = searchOverlayQuery(state);
    if (current === undefined || !sameQuery(current, query)) return state;
    return {
        ...state,
        results,
        searching: false,
        ...(results.results[0] === undefined ? {} : {
            selected: {
                sessionId: results.results[0].session_id,
                hitIndex: 0,
            },
        }),
    };
}

export function applySearchFailure(
    state: SearchOverlayState,
    query: SessionSearchQuery,
    notice: string,
): SearchOverlayState {
    const current = searchOverlayQuery(state);
    if (current === undefined || !sameQuery(current, query)) return state;
    return { ...state, notice, searching: false, results: undefined };
}

function sameQuery(
    left: SessionSearchQuery,
    right: SessionSearchQuery,
): boolean {
    return left.query === right.query
        && left.kind === right.kind
        && left.workspace === right.workspace
        && left.session_id === right.session_id;
}

export function searchSelections(
    state: SearchOverlayState,
): readonly SearchSelection[] {
    return (state.results?.results ?? []).flatMap((result) =>
        result.hits.map((_, hitIndex) => ({
            sessionId: result.session_id,
            hitIndex,
        })));
}

export function moveSearchSelection(
    state: SearchOverlayState,
    delta: number,
): SearchSelection | undefined {
    const selections = searchSelections(state);
    if (selections.length === 0) return undefined;
    const at = selections.findIndex((candidate) =>
        sameSelection(candidate, state.selected));
    if (at === -1) return selections[0];
    return selections[Math.min(selections.length - 1, Math.max(0, at + delta))];
}

function sameSelection(
    left: SearchSelection,
    right: SearchSelection | undefined,
): boolean {
    return right !== undefined
        && left.sessionId === right.sessionId
        && left.hitIndex === right.hitIndex;
}

export function openSelected(
    state: SearchOverlayState,
): SearchOverlayAction | undefined {
    const selected = state.selected;
    const result = selected === undefined ? undefined : state.results?.results
        .find((candidate) => candidate.session_id === selected.sessionId);
    const hit = result?.hits[selected?.hitIndex ?? 0];
    if (result === undefined || hit === undefined) return undefined;
    return {
        kind: "open",
        session_id: result.session_id,
        session_path: result.session_path,
        entry_id: hit.entry_id,
    };
}

export interface SearchOverlayLine {
    readonly kind: "result" | "hit" | "blank" | "notice";
    readonly text: string;
    readonly session_id?: string;
    readonly row_id?: string;
    readonly selected?: boolean;
    readonly stale?: boolean;
    readonly emphasis?: { readonly start: number; readonly length: number };
}

export function searchRowId(selection: SearchSelection): string {
    return `${selection.sessionId}\u0000${selection.hitIndex}`;
}

export function searchSelectionOf(
    rowId: string,
): SearchSelection | undefined {
    const split = rowId.lastIndexOf("\u0000");
    if (split === -1) return undefined;
    const hitIndex = Number(rowId.slice(split + 1));
    return Number.isSafeInteger(hitIndex) && hitIndex >= 0
        ? { sessionId: rowId.slice(0, split), hitIndex }
        : undefined;
}

const HIT_PREFIXES: Readonly<Record<SessionSearchHit["kind"], string>> = {
    user_message: "you:",
    agent_message: "agent:",
    tool_command: "ran:",
    file_edit: "edited:",
};

function widerScope(state: SearchOverlayState): SearchScope {
    const scopes = availableScopes(state.sessionId);
    const at = scopes.indexOf(state.scope);
    return scopes[(at + 1) % scopes.length]!;
}

const SCOPE_WORDS: Readonly<Record<SearchScope, string>> = {
    conversation: "this conversation",
    workspace: "this workspace",
    everywhere: "everywhere",
};

export function searchOverlayHeader(state: SearchOverlayState): string {
    const scope = SCOPE_WORDS[state.scope];
    const filter = state.filter ?? "all";
    return `Search · ${filter} · ${scope}`;
}

export function searchOverlayFooter(width: number): string {
    return width < SEARCH_NARROW_WIDTH
        ? "↑↓ ^u^d enter tab ^w esc"
        : "↑↓ ^u ^d move   enter open at match"
            + "   tab filter   ctrl+w scope   esc back";
}

export function searchOverlayLines(
    state: SearchOverlayState,
    layout: { readonly width: number; readonly now?: Date },
): readonly SearchOverlayLine[] {
    const now = layout.now ?? new Date();
    const lines: SearchOverlayLine[] = [];
    if (state.notice !== undefined) {
        lines.push({ kind: "notice", text: state.notice });
        return lines;
    }
    if (state.query.trim().length === 0) {
        lines.push({ kind: "notice", text: "Type to search past work." });
        return lines;
    }
    const needle = state.query.trim().toLowerCase();
    const results = state.results?.results ?? [];
    if (state.searching && results.length === 0) {
        lines.push({ kind: "notice", text: "Searching…" });
        return lines;
    }
    if (!state.searching && results.length === 0) {
        lines.push({ kind: "notice", text: "No matches." });
        return lines;
    }
    const stale = state.searching;
    for (const result of results) {
        lines.push({ kind: "blank", text: "" });
        const age = relativeTime(result.updated_at, now, "");
        const title = `  ${result.title}`;
        const gap = Math.max(1, layout.width - title.length - age.length);
        lines.push({
            kind: "result",
            text: clip(`${title}${" ".repeat(gap)}${age}`, layout.width),
            session_id: result.session_id,
            stale,
        });
        result.hits.forEach((hit, hitIndex) => {
            const selected = state.selected?.sessionId === result.session_id
                && state.selected.hitIndex === hitIndex;
            const text = clip(
                `    ${HIT_PREFIXES[hit.kind]} ${hit.snippet}`,
                layout.width,
            );
            const emphasis = matchRun(text, needle);
            lines.push({
                kind: "hit",
                text,
                session_id: result.session_id,
                row_id: searchRowId({
                    sessionId: result.session_id,
                    hitIndex,
                }),
                selected,
                stale,
                ...(emphasis === undefined ? {} : { emphasis }),
            });
        });
    }
    if (state.results?.truncated === true) {
        lines.push({ kind: "blank", text: "" });
        lines.push({
            kind: "notice",
            text: "More sessions matched than are shown; narrow the search.",
        });
    }
    return lines;
}

export function searchOverlayText(
    state: SearchOverlayState,
    layout: { readonly width: number; readonly now?: Date },
): string {
    return [
        `> ${state.query}`,
        ...searchOverlayLines(state, layout).map((line) => line.text),
    ].join("\n");
}

function matchRun(
    text: string,
    needle: string,
): { readonly start: number; readonly length: number } | undefined {
    if (needle.length === 0) return undefined;
    const at = text.toLowerCase().indexOf(needle);
    return at === -1 || at + needle.length > text.length
        ? undefined
        : { start: at, length: needle.length };
}

function clip(value: string, columns: number): string {
    if (columns <= 0) return "";
    return value.length <= columns
        ? value
        : `${value.slice(0, Math.max(1, columns - 1))}…`;
}

export function searchOverlayViewState(
    state: SearchOverlayState,
    width: number,
    now?: Date,
): LinesViewState {
    const lines = searchOverlayLines(state, {
        width,
        ...(now === undefined ? {} : { now }),
    });
    const cursorLine = lines.findIndex((line) => line.selected === true);
    return {
        title: searchOverlayHeader(state),
        input: {
            text: state.query,
            cursor: state.queryCursor,
            placeholder: "Search",
        },
        ...(cursorLine === -1 ? {} : { cursorLine }),
        lines: lines.map((line) => ({
            text: line.text,
            ...(line.row_id === undefined ? {} : { rowId: line.row_id }),
            ...(line.selected === true ? { selected: true } : {}),
            ...(line.emphasis === undefined ? {} : { emphasis: line.emphasis }),
            tone: line.stale === true
                ? "muted" as const
                : line.kind === "result"
                    ? "text" as const
                    : "muted" as const,
        })),
        footer: searchOverlayFooter(width),
    };
}
