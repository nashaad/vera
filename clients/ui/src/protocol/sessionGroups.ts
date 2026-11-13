import type { SessionRow } from "./sessions.ts";

export interface SessionEntry {
    readonly row: SessionRow;
    // One level only: a child of a child is listed under the top parent in the group.
    readonly nested: boolean;
}

export interface SessionGroup {
    // Unique among groups; the Pinned and Chats groups have their own keys.
    readonly key: string;
    // Empty for the Pinned and Chats groups and for sessions with no folder.
    readonly workspace: string;
    readonly title: string;
    // Chats share one group and its title opens no workspace page.
    readonly chats: boolean;
    readonly entries: readonly SessionEntry[];
}

export const CHATS_TITLE = "Chats";
export const PINNED_TITLE = "Pinned";
export const CHAT_FOLDER_LABEL = "Chat";

// The folder a session is shown under: a chat has none of its own to name.
export function rowFolderName(row: Pick<SessionRow, "workspace" | "chat">): string {
    return row.chat ? CHAT_FOLDER_LABEL : folderName(row.workspace);
}

// The folder path for a tooltip; a chat has no path to show.
export function rowFolderPath(row: Pick<SessionRow, "workspace" | "chat">): string | undefined {
    return row.chat || row.workspace.length === 0 ? undefined : row.workspace;
}

// The last part of a folder path, for a group heading.
export function folderName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    if (trimmed.length === 0) return path.length > 0 ? path : "No folder";
    const parts = trimmed.split(/[\\/]/);
    return parts[parts.length - 1] ?? trimmed;
}

const PINNED_KEY = "pinned";
const CHATS_KEY = "chats";
const FOLDER_KEY = "folder:";

// Pinned rows come first in pin order and leave their own group. The other groups keep the order
// of their most recent session; rows keep the host's order, and a row whose parent is in the same
// group follows that parent. Chats share one group.
export function groupSessions(rows: readonly SessionRow[], pins: readonly string[] = []): readonly SessionGroup[] {
    const pinned = pinnedRows(rows, pins);
    const pinnedIds = new Set(pinned.map((row) => row.id));
    const groups: SessionGroup[] = pinned.length === 0 ? [] : [{
        key: PINNED_KEY,
        workspace: "",
        title: PINNED_TITLE,
        chats: false,
        entries: pinned.map((row) => ({ row, nested: false })),
    }];
    const byKey = new Map<string, SessionRow[]>();
    for (const row of rows) {
        if (pinnedIds.has(row.id)) continue;
        const key = row.chat ? CHATS_KEY : `${FOLDER_KEY}${row.workspace}`;
        const members = byKey.get(key);
        if (members === undefined) byKey.set(key, [row]);
        else members.push(row);
    }
    for (const [key, members] of byKey) {
        const chats = key === CHATS_KEY;
        const workspace = chats ? "" : key.slice(FOLDER_KEY.length);
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
        groups.push({ key, workspace, title: chats ? CHATS_TITLE : folderName(workspace), chats, entries });
    }
    return groups;
}

function pinnedRows(rows: readonly SessionRow[], pins: readonly string[]): readonly SessionRow[] {
    if (pins.length === 0) return [];
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return pins.flatMap((id) => rowsById.get(id) ?? []);
}

export function waitingCount(rows: readonly SessionRow[]): number {
    return rows.filter((row) => row.status === "waiting").length;
}
