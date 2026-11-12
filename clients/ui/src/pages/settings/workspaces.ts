import type { SessionRow } from "../../protocol/sessions.ts";
import type { WorkspaceStats } from "../WorkspacePage.tsx";

export const FOLDER_LIMIT = 50;

// Distinct folders of the loaded sessions, the most recently active first. Rows without a folder are skipped.
export function workspaceFolders(rows: readonly SessionRow[], limit: number = FOLDER_LIMIT): readonly string[] {
    const newest = new Map<string, number | undefined>();
    for (const row of rows) {
        if (row.workspace.length === 0) continue;
        const known = newest.get(row.workspace);
        if (!newest.has(row.workspace)) newest.set(row.workspace, row.updatedAt);
        else if (row.updatedAt !== undefined && (known === undefined || row.updatedAt > known)) newest.set(row.workspace, row.updatedAt);
    }
    const folders = [...newest.keys()];
    // The sort is stable, so folders with the same age keep the host's order.
    folders.sort((left, right) => activity(newest.get(right)) - activity(newest.get(left)));
    return folders.slice(0, Math.max(0, limit));
}

function activity(updatedAt: number | undefined): number {
    return updatedAt ?? Number.NEGATIVE_INFINITY;
}

// A short line for a folder row, such as "3 sessions · last active 2h ago".
export function folderSummary(stats: WorkspaceStats): string {
    const count = stats.sessions === "1" ? "1 session" : `${stats.sessions} sessions`;
    return `${count} · last active ${stats.lastActive.toLowerCase()}`;
}
