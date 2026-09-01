import type { LinesViewState } from "./lines-view.ts";
import { relativeTime } from "../../src/relative-time.ts";
import type {
    WorkIndexSnapshot,
    WorkRow,
    WorkSection,
} from "../../src/host/work-index.ts";

/** The Work tab's presentation model, with no OpenTUI in it. Every fact the tab shows is a string here, so the layout, the selection, and what enter does are all decidable without… */

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
const TITLE_COLUMN_MAX = 40;
const MIN_SUMMARY = 8;

export type WorkTabLineKind = "section" | "row" | "blank" | "empty";

export interface WorkTabLine {
    readonly kind: WorkTabLineKind;
    readonly text: string;
    readonly row_id?: string;
    readonly selected?: boolean;
}

export type WorkTabAction =
    | { readonly kind: "answer_request"; readonly session_id: string }
    | { readonly kind: "open_session"; readonly session_id: string }
    | { readonly kind: "open_result"; readonly session_id: string };

export interface WorkTabState {
    readonly index: WorkIndexSnapshot;
    readonly selectedId?: string;
}

export function startWorkTab(index: WorkIndexSnapshot): WorkTabState {
    const selectedId = firstWorkRowId(index);
    return { index, ...(selectedId === undefined ? {} : { selectedId }) };
}

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

export function tuiWorkTabHeader(index: WorkIndexSnapshot): string {
    const section = (name: WorkSection): number =>
        index.rows.filter((row) => row.section === name).length;
    const review = section("ready_to_review");
    const done = section("done_recently");
    const parts = [
        ...(index.needs_you === 0 ? [] : [`${index.needs_you} need you`]),
        ...(index.working === 0 ? [] : [`${index.working} working`]),
        ...(review === 0 ? [] : [`${review} to review`]),
        ...(done === 0 ? [] : [`${done} done`]),
    ];
    return parts.length === 0 ? "Work" : `Work · ${parts.join(" · ")}`;
}

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
    const workspaces =
        new Set(index.rows.map((row) => row.workspace)).size > 1;
    const lines: WorkTabLine[] = [];
    for (const section of SECTION_ORDER) {
        const rows = index.rows.filter((row) => row.section === section);
        if (rows.length === 0) continue;
        if (lines.length > 0 && !narrow) lines.push({ kind: "blank", text: "" });
        lines.push({
            kind: "section",
            text: `${SECTION_TITLES[section]} · ${rows.length}`,
        });
        if (!narrow) lines.push({ kind: "blank", text: "" });
        for (const row of rows) {
            lines.push({
                kind: "row",
                text: rowText(row, layout.width, narrow, now, workspaces),
                row_id: row.id,
                selected: row.id === layout.selectedId,
            });
        }
    }
    return lines;
}

export function tuiWorkTabText(
    index: WorkIndexSnapshot,
    layout: WorkTabLayout,
): string {
    return tuiWorkTabLines(index, layout).map((line) => line.text).join("\n");
}

export function firstWorkRowId(
    index: WorkIndexSnapshot,
): string | undefined {
    return index.rows[0]?.id;
}

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
    workspaces: boolean,
): string {
    const age = relativeTime(row.updated_at, now, "");
    const trailing = narrow
        ? age
        : [
            ...(workspaces && row.workspace !== ""
                ? [workspaceName(row.workspace)]
                : []),
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
    const titleColumn = narrow
        ? TITLE_COLUMN
        : Math.min(TITLE_COLUMN_MAX, Math.max(
            TITLE_COLUMN + 4,
            Math.floor(width / 3),
        ));
    const title = pad(row.title, titleColumn);
    const used = title.length + reason.length + trailing.length + 2;
    const summaryText =
        row.summary === SECTION_TITLES[row.section] ? "" : row.summary;
    const summary = clip(summaryText, Math.max(MIN_SUMMARY, width - used));
    const left = `${title}${reason}${summary}`;
    const gap = Math.max(1, width - left.length - trailing.length);
    return trailing === ""
        ? left.trimEnd()
        : `${left}${" ".repeat(gap)}${trailing}`;
}

function workspaceName(workspace: string): string {
    const segments = workspace.split("/").filter((part) => part.length > 0);
    return segments.at(-1) ?? workspace;
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
            ...(line.selected === true ? { selected: true } : {}),
            tone: line.kind === "section"
                ? "accent" as const
                : line.kind === "row"
                    ? "text" as const
                    : "muted" as const,
        })),
        footer: tuiWorkTabFooter(width),
    };
}
