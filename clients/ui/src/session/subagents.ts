import type { SessionRow, SessionStatus } from "../protocol/sessions.ts";
import type { BackgroundAgents } from "./model.ts";

const STATUS_WORDS: Readonly<Record<SessionStatus, string>> = {
    working: "Working",
    waiting: "Waiting",
    idle: "Idle",
    completed: "Done",
    other: "Ended",
};

export function statusWord(status: SessionStatus): string {
    return STATUS_WORDS[status];
}

export function isRunningRow(row: SessionRow): boolean {
    return row.status === "working" || row.status === "waiting";
}

// The session's child rows, running ones first; the host's order is kept within each group.
export function childRows(rows: readonly SessionRow[], parentId: string): SessionRow[] {
    return rows
        .filter((row) => row.parentId === parentId)
        .sort((left, right) => Number(isRunningRow(right)) - Number(isRunningRow(left)));
}

export interface ChildLists {
    // Working or waiting children.
    readonly active: readonly SessionRow[];
    // Every other child; the host's order is kept within each list.
    readonly done: readonly SessionRow[];
}

export function splitChildren(rows: readonly SessionRow[], parentId: string): ChildLists {
    const children = childRows(rows, parentId);
    return { active: children.filter(isRunningRow), done: children.filter((row) => !isRunningRow(row)) };
}

// The listed child rows may lag the session's own children, so the larger of the two wins.
export function runningChildCount(rows: readonly SessionRow[], parentId: string, background: BackgroundAgents | undefined): number {
    const listed = rows.filter((row) => row.parentId === parentId && isRunningRow(row)).length;
    return Math.max(listed, background?.children.length ?? 0);
}

// Running children the session reports by title but the listing does not carry.
export function unlistedChildTitles(background: BackgroundAgents | undefined, rows: readonly SessionRow[]): string[] {
    if (background === undefined) return [];
    const names = new Set(rows.map((row) => row.name));
    return [...new Set(background.children.filter((title) => !names.has(title)))];
}
