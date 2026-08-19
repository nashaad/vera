import type { LinesViewState } from "./lines-view.ts";
import { relativeTime } from "../../src/relative-time.ts";
import type {
    WorkIndexSnapshot,
    WorkRow,
    WorkSection,
} from "../../src/host/work-index.ts";

/**
 * The Work tab's presentation model, with no OpenTUI in it.
 *
 * Every fact the tab shows is a string here, so the layout, the selection, and
 * what enter does are all decidable without a terminal. The renderable side
 * mounts these lines; it decides nothing.
 */

/** Below this the tab drops the reason column and runs one column of rows. */
export const WORK_TAB_NARROW_WIDTH = 64;

const SECTION_TITLES: Readonly<Record<WorkSection, string>> = {
    needs_you: "Needs you",
    working: "Working",
    ready_to_review: "Ready to review",
    done_recently: "Done recently",
};

const SECTION_ORDER: readonly WorkSection[] = [
    "needs_you",
    "working",
    "ready_to_review",
    "done_recently",
];

const REASON_LABELS: Readonly<Record<string, string>> = {
    approval: "Approval",
    question: "Question",
    failure: "Failed",
};

const REASON_COLUMN = 10;
const TITLE_COLUMN = 20;
const POINTER_COLUMN = 2;
const MIN_SUMMARY = 8;

export type WorkTabLineKind = "section" | "row" | "blank" | "empty";

export interface WorkTabLine {
    readonly kind: WorkTabLineKind;
    readonly text: string;
    /** Present on `row` lines only, so a click or a cursor can name the row. */
    readonly row_id?: string;
    readonly selected?: boolean;
}

/**
 * What pressing enter on a row means.
 *
 * `answer_request` routes to the approval or question surface the TUI already
 * has. The Work tab never renders a request itself: two renderers for one
 * request is two behaviours for one decision.
 */
export type WorkTabAction =
    | { readonly kind: "answer_request"; readonly session_id: string }
    | { readonly kind: "open_session"; readonly session_id: string }
    | { readonly kind: "open_result"; readonly session_id: string };

/** What the client holds while the tab is open. */
export interface WorkTabState {
    readonly index: WorkIndexSnapshot;
    readonly selectedId?: string;
}

export function startWorkTab(index: WorkIndexSnapshot): WorkTabState {
    const selectedId = firstWorkRowId(index);
    return { index, ...(selectedId === undefined ? {} : { selectedId }) };
}

/** A fresh index from the host, with the cursor kept where the eyes are. */
export function applyWorkIndex(
    state: WorkTabState,
    index: WorkIndexSnapshot,
): WorkTabState {
    const selectedId = reselectWorkRow(state.index, index, state.selectedId);
    return { index, ...(selectedId === undefined ? {} : { selectedId }) };
}

export interface WorkTabTransition {
    readonly state?: WorkTabState;
    readonly action?: WorkTabAction | { readonly kind: "close" };
    readonly handled: boolean;
}

/**
 * Arrows move, enter acts, escape goes back. Every chord is passed through so
 * the globals, ctrl+c above all, still reach the client from inside the tab.
 */
export function handleWorkTabKey(
    state: WorkTabState,
    key: {
        readonly name: string;
        readonly ctrl?: boolean;
        readonly meta?: boolean;
        readonly shift?: boolean;
    },
): WorkTabTransition {
    if (key.ctrl || key.meta || key.shift) return { state, handled: false };
    if (key.name === "escape") {
        return { action: { kind: "close" }, handled: true };
    }
    if (key.name === "up" || key.name === "down") {
        const selectedId = moveWorkTabSelection(
            state.index,
            state.selectedId,
            key.name === "up" ? -1 : 1,
        );
        return {
            state: selectedId === undefined ? state : { ...state, selectedId },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        const action = workTabAction(state.index, state.selectedId);
        return action === undefined
            ? { state, handled: true }
            : { action, handled: true };
    }
    return { state, handled: false };
}

/** The tab title, counts included, as one line of assertable text. */
export function tuiWorkTabHeader(index: WorkIndexSnapshot): string {
    const parts = [
        ...(index.needs_you === 0 ? [] : [`${index.needs_you} need you`]),
        ...(index.working === 0 ? [] : [`${index.working} working`]),
    ];
    return parts.length === 0 ? "Work" : `Work · ${parts.join(" · ")}`;
}

/** The footer hint, shortened when the terminal has no room for words. */
export function tuiWorkTabFooter(width: number): string {
    return width < WORK_TAB_NARROW_WIDTH
        ? "↑↓ enter esc"
        : "↑↓ select   enter open   esc back";
}

export interface WorkTabLayout {
    readonly width: number;
    readonly selectedId?: string;
    readonly now?: Date;
}

export function tuiWorkTabLines(
    index: WorkIndexSnapshot,
    layout: WorkTabLayout,
): readonly WorkTabLine[] {
    if (index.rows.length === 0) {
        return [{ kind: "empty", text: "Nothing is waiting on you." }];
    }
    const now = layout.now ?? new Date();
    const narrow = layout.width < WORK_TAB_NARROW_WIDTH;
    const lines: WorkTabLine[] = [];
    for (const section of SECTION_ORDER) {
        const rows = index.rows.filter((row) => row.section === section);
        if (rows.length === 0) continue;
        if (lines.length > 0 && !narrow) lines.push({ kind: "blank", text: "" });
        lines.push({ kind: "section", text: SECTION_TITLES[section] });
        if (!narrow) lines.push({ kind: "blank", text: "" });
        for (const row of rows) {
            lines.push({
                kind: "row",
                text: rowText(row, layout.width, narrow, now,
                    row.id === layout.selectedId),
                row_id: row.id,
                selected: row.id === layout.selectedId,
            });
        }
    }
    return lines;
}

/** The lines as one block of text, for the headless renderer and for tests. */
export function tuiWorkTabText(
    index: WorkIndexSnapshot,
    layout: WorkTabLayout,
): string {
    return tuiWorkTabLines(index, layout).map((line) => line.text).join("\n");
}

/**
 * The row a fresh open selects: the first one, which is the most urgent one,
 * because the sections are ordered by urgency and each is newest first.
 */
export function firstWorkRowId(
    index: WorkIndexSnapshot,
): string | undefined {
    return index.rows[0]?.id;
}

/**
 * The selection after the arrow keys move it.
 *
 * Clamped rather than wrapped: the top row is the one that needs you most, so
 * pressing up at the top should stay there rather than jump to finished work.
 */
export function moveWorkTabSelection(
    index: WorkIndexSnapshot,
    selectedId: string | undefined,
    delta: number,
): string | undefined {
    if (index.rows.length === 0) return undefined;
    const current = index.rows.findIndex((row) => row.id === selectedId);
    if (current === -1) return index.rows[0]?.id;
    const next = Math.min(
        index.rows.length - 1,
        Math.max(0, current + delta),
    );
    return index.rows[next]?.id;
}

/**
 * The selection to keep after the host sends a new index.
 *
 * Rows leave the inbox under the cursor all the time: answering an approval
 * removes the row that was selected. Holding the position rather than the id
 * keeps the cursor where the person's eyes are.
 */
export function reselectWorkRow(
    previous: WorkIndexSnapshot,
    next: WorkIndexSnapshot,
    selectedId: string | undefined,
): string | undefined {
    if (selectedId !== undefined
        && next.rows.some((row) => row.id === selectedId)) {
        return selectedId;
    }
    if (next.rows.length === 0) return undefined;
    const position = previous.rows.findIndex((row) => row.id === selectedId);
    if (position === -1) return next.rows[0]?.id;
    return next.rows[Math.min(position, next.rows.length - 1)]?.id;
}

export function workTabAction(
    index: WorkIndexSnapshot,
    selectedId: string | undefined,
): WorkTabAction | undefined {
    const row = index.rows.find((candidate) => candidate.id === selectedId);
    if (row === undefined) return undefined;
    if (row.reason === "approval" || row.reason === "question") {
        return { kind: "answer_request", session_id: row.session_id };
    }
    if (row.section === "done_recently") {
        return { kind: "open_result", session_id: row.session_id };
    }
    return { kind: "open_session", session_id: row.session_id };
}

function rowText(
    row: WorkRow,
    width: number,
    narrow: boolean,
    now: Date,
    selected: boolean,
): string {
    const pointer = selected ? "> " : "  ";
    const age = relativeTime(row.updated_at, now, "");
    const trailing = narrow
        ? age
        : [
            ...(row.subagent_count === undefined
                ? []
                : [`${row.subagent_count} ${
                    row.subagent_count === 1 ? "subagent" : "subagents"
                }`]),
            ...(age === "" ? [] : [age]),
        ].join("  ");
    const reason = narrow
        ? ""
        : pad(REASON_LABELS[row.reason ?? ""] ?? "", REASON_COLUMN);
    const title = pad(row.title, narrow ? TITLE_COLUMN : TITLE_COLUMN + 4);
    const used = POINTER_COLUMN + title.length + reason.length
        + trailing.length + 2;
    const summary = clip(row.summary, Math.max(MIN_SUMMARY, width - used));
    const left = `${pointer}${title}${reason}${summary}`;
    const gap = Math.max(1, width - left.length - trailing.length);
    return trailing === ""
        ? left.trimEnd()
        : `${left}${" ".repeat(gap)}${trailing}`;
}

function pad(value: string, columns: number): string {
    const clipped = clip(value, columns - 1);
    return clipped.padEnd(columns, " ");
}

function clip(value: string, columns: number): string {
    if (columns <= 0) return "";
    return value.length <= columns
        ? value
        : `${value.slice(0, Math.max(1, columns - 1))}…`;
}

/** The Work tab as the shared card draws it. */
export function workTabViewState(
    state: WorkTabState,
    width: number,
    now?: Date,
): LinesViewState {
    const lines = tuiWorkTabLines(state.index, {
        width,
        ...(state.selectedId === undefined
            ? {}
            : { selectedId: state.selectedId }),
        ...(now === undefined ? {} : { now }),
    });
    const cursorLine = lines.findIndex((line) => line.selected === true);
    return {
        title: tuiWorkTabHeader(state.index),
        ...(cursorLine === -1 ? {} : { cursorLine }),
        lines: lines.map((line) => ({
            text: line.text,
            ...(line.row_id === undefined ? {} : { rowId: line.row_id }),
            tone: line.kind === "section"
                ? "accent" as const
                : line.kind === "empty"
                    ? "muted" as const
                    : line.selected === true
                        ? "text" as const
                        : "muted" as const,
        })),
        footer: tuiWorkTabFooter(width),
    };
}
