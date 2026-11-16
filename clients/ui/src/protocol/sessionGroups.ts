import type { SessionRow } from "./sessions.ts";

export interface SessionEntry {
    readonly row: SessionRow;
    // One level only: a child of a child is listed under the top parent.
    readonly nested: boolean;
    // How many rows are listed under this one; 0 on a nested row.
    readonly nestedCount: number;
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
// of their most recent listed session; rows keep the host's order. A subagent is listed under the
// session that started it, in that session's group, whatever its own folder or chat flag. Chats
// share one group.
export function groupSessions(rows: readonly SessionRow[], pins: readonly string[] = []): readonly SessionGroup[] {
    const pinned = pinnedRows(rows, pins);
    const pinnedIds = new Set(pinned.map((row) => row.id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    // The row a session is listed under: the nearest pinned ancestor, else the top parent among
    // all listed rows. A pinned row, a row with no listed parent and a row in a loop lead their own.
    const topOf = (row: SessionRow): SessionRow => {
        if (pinnedIds.has(row.id)) return row;
        let current = row;
        const seen = new Set<string>([row.id]);
        for (;;) {
            const parent = current.parentId === undefined ? undefined : byId.get(current.parentId);
            if (parent === undefined) return current;
            if (pinnedIds.has(parent.id)) return parent;
            if (seen.has(parent.id)) return row;
            seen.add(parent.id);
            current = parent;
        }
    };
    const nestedUnder = new Map<string, SessionRow[]>();
    const leadersByKey = new Map<string, SessionRow[]>();
    for (const row of rows) {
        const top = topOf(row);
        if (top !== row) {
            const list = nestedUnder.get(top.id);
            if (list === undefined) nestedUnder.set(top.id, [row]);
            else list.push(row);
        }
        if (pinnedIds.has(top.id)) continue;
        const key = top.chat ? CHATS_KEY : `${FOLDER_KEY}${top.workspace}`;
        let leaders = leadersByKey.get(key);
        if (leaders === undefined) {
            leaders = [];
            leadersByKey.set(key, leaders);
        }
        if (top === row) leaders.push(row);
    }
    const entriesOf = (leaders: readonly SessionRow[]): SessionEntry[] => leaders.flatMap((leader) => {
        const kids = nestedUnder.get(leader.id) ?? [];
        return [
            { row: leader, nested: false, nestedCount: kids.length },
            ...kids.map((row) => ({ row, nested: true, nestedCount: 0 })),
        ];
    });
    const groups: SessionGroup[] = pinned.length === 0 ? [] : [{
        key: PINNED_KEY,
        workspace: "",
        title: PINNED_TITLE,
        chats: false,
        entries: entriesOf(pinned),
    }];
    for (const [key, leaders] of leadersByKey) {
        const chats = key === CHATS_KEY;
        const workspace = chats ? "" : key.slice(FOLDER_KEY.length);
        groups.push({ key, workspace, title: chats ? CHATS_TITLE : folderName(workspace), chats, entries: entriesOf(leaders) });
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
