import type { SessionRow } from "./sessions.ts";

export interface SessionEntry {
    readonly row: SessionRow;
    // One level only: a child of a child is listed under the top parent in the group.
    readonly nested: boolean;
}

export interface SessionGroup {
    readonly workspace: string;
    readonly title: string;
    readonly entries: readonly SessionEntry[];
}

// The last part of a folder path, for a group heading.
export function folderName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    if (trimmed.length === 0) return path.length > 0 ? path : "No folder";
    const parts = trimmed.split(/[\\/]/);
    return parts[parts.length - 1] ?? trimmed;
}

// Groups keep the order of their most recent session; rows keep the host's order, and a
// row whose parent is in the same group follows that parent.
export function groupSessions(rows: readonly SessionRow[]): readonly SessionGroup[] {
    const byWorkspace = new Map<string, SessionRow[]>();
    for (const row of rows) {
        const members = byWorkspace.get(row.workspace);
        if (members === undefined) byWorkspace.set(row.workspace, [row]);
        else members.push(row);
    }
    const groups: SessionGroup[] = [];
    for (const [workspace, members] of byWorkspace) {
        const byId = new Map(members.map((row) => [row.id, row]));
        const rootOf = (row: SessionRow): string => {
            let current = row;
            const seen = new Set<string>([row.id]);
            for (;;) {
                const parent = current.parentId === undefined ? undefined : byId.get(current.parentId);
                if (parent === undefined) return current.id;
                // A loop in the parent links lists the row on its own.
                if (seen.has(parent.id)) return row.id;
                seen.add(parent.id);
                current = parent;
            }
        };
        const children = new Map<string, SessionRow[]>();
        const roots: SessionRow[] = [];
        for (const row of members) {
            const root = rootOf(row);
            if (root === row.id) {
                roots.push(row);
                continue;
            }
            const list = children.get(root);
            if (list === undefined) children.set(root, [row]);
            else list.push(row);
        }
        const entries: SessionEntry[] = [];
        for (const root of roots) {
            entries.push({ row: root, nested: false });
            for (const child of children.get(root.id) ?? []) entries.push({ row: child, nested: true });
        }
        groups.push({ workspace, title: folderName(workspace), entries });
    }
    return groups;
}

export function waitingCount(rows: readonly SessionRow[]): number {
    return rows.filter((row) => row.status === "waiting").length;
}
