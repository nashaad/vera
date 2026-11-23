import { SESSIONS_PAGE_SIZE, type SessionRow, type SessionStatus } from "./sessions.ts";

const STATUSES: readonly SessionStatus[] = ["idle", "working", "waiting", "completed", "other"];

export function sessionCachePath(home: string): string {
    return `${home.replace(/[\\/]+$/, "")}/machine/cache/desktop-session-rows.json`;
}

export function parseSessionCache(value: unknown): readonly SessionRow[] | undefined {
    if (!Array.isArray(value) || value.length > SESSIONS_PAGE_SIZE) return undefined;
    const rows: SessionRow[] = [];
    for (const item of value) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
        const row = item as Record<string, unknown>;
        if (typeof row.id !== "string" || row.id.length === 0
            || typeof row.name !== "string" || typeof row.workspace !== "string"
            || typeof row.status !== "string" || !STATUSES.includes(row.status as SessionStatus)
            || typeof row.live !== "boolean" || typeof row.chat !== "boolean"
            || (row.updatedAt !== undefined && (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)))
            || (row.archived !== undefined && typeof row.archived !== "boolean")
            || (row.parentId !== undefined && (typeof row.parentId !== "string" || row.parentId.length === 0))
            || (row.backgroundCommands !== undefined && (!Number.isSafeInteger(row.backgroundCommands) || (row.backgroundCommands as number) <= 0))) {
            return undefined;
        }
        rows.push({
            id: row.id,
            name: row.name,
            workspace: row.workspace,
            status: row.status as SessionStatus,
            live: row.live,
            chat: row.chat,
            ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt as number }),
            ...(row.archived === undefined ? {} : { archived: row.archived as boolean }),
            ...(row.parentId === undefined ? {} : { parentId: row.parentId as string }),
            ...(row.backgroundCommands === undefined ? {} : { backgroundCommands: row.backgroundCommands as number }),
        });
    }
    return rows;
}
