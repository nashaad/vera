import type { SessionRow } from "../protocol/sessions.ts";
import type { BackgroundAgents } from "./model.ts";

export function isRunningRow(row: SessionRow): boolean {
    return row.status === "working" || row.status === "waiting";
}

// The session's child rows, running ones first; the host's order is kept within each group.
export function childRows(rows: readonly SessionRow[], parentId: string): SessionRow[] {
    return rows
        .filter((row) => row.parentId === parentId)
        .sort((left, right) => Number(isRunningRow(right)) - Number(isRunningRow(left)));
}

// The listed child rows may lag the session's own count, so the larger of the two wins.
export function runningChildCount(rows: readonly SessionRow[], parentId: string, background: BackgroundAgents | undefined): number {
    const listed = rows.filter((row) => row.parentId === parentId && isRunningRow(row)).length;
    return Math.max(listed, background?.running ?? 0);
}

// Running children the session reports by title but the listing does not carry.
export function unlistedChildTitles(background: BackgroundAgents | undefined, rows: readonly SessionRow[]): string[] {
    if (background === undefined) return [];
    const names = new Set(rows.map((row) => row.name));
    return [...new Set(background.children.filter((title) => !names.has(title)))];
}

// The subagent the person chose for this session, else a running child, else the newest one.
export function companionFor(
    agentId: string,
    chosen: { readonly parentId: string; readonly agentId: string } | undefined,
    rows: readonly SessionRow[] | undefined,
): string | undefined {
    if (chosen !== undefined && chosen.parentId === agentId) return chosen.agentId;
    const children = (rows ?? []).filter((row) => row.parentId === agentId);
    const running = children.find(isRunningRow);
    if (running !== undefined) return running.id;
    const newest = [...children].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0];
    return newest?.id;
}
