import type { SessionRow } from "./sessions.ts";

export const CHATS_TITLE = "Chats";
export const PINNED_TITLE = "Pinned";
export const ARCHIVED_TITLE = "Archived";
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

export function waitingCount(rows: readonly SessionRow[]): number {
    return rows.filter((row) => row.status === "waiting").length;
}
