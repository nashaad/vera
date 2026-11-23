import type { AgentListFacts } from "./client.ts";

export const SESSIONS_PAGE_SIZE = 50;

export function sessionPageOptions(cursor?: string): { readonly limit: number; readonly order: "recent"; readonly cursor?: string } {
    return { limit: SESSIONS_PAGE_SIZE, order: "recent", ...(cursor === undefined ? {} : { cursor }) };
}

export function mergeSessionRows(firstPage: readonly SessionRow[], tail: readonly SessionRow[]): readonly SessionRow[] {
    const ids = new Set(firstPage.map((row) => row.id));
    return [...firstPage, ...tail.filter((row) => !ids.has(row.id))];
}

export function sessionCursor(rows: readonly SessionRow[]): string | undefined {
    return rows.at(-1)?.id;
}

export interface SessionTailPage {
    readonly rows: readonly SessionRow[];
    readonly nextCursor?: string;
    readonly pages: number;
}

export async function loadSessionTailPage(
    firstPage: readonly SessionRow[],
    tail: readonly SessionRow[],
    nextCursor: string | undefined,
    maxPages: number,
    list: (cursor: string) => Promise<AgentListFacts>,
    targetLength?: number,
): Promise<SessionTailPage> {
    let nextTail = [...tail];
    let cursor = nextCursor === undefined ? undefined : sessionCursor(mergeSessionRows(firstPage, nextTail));
    let pages = 0;
    while (cursor !== undefined && pages < maxPages) {
        const response = await list(cursor);
        pages += 1;
        const known = new Set(mergeSessionRows(firstPage, nextTail).map((row) => row.id));
        const received: SessionRow[] = [];
        for (const row of sessionRows(response)) {
            if (known.has(row.id)) continue;
            known.add(row.id);
            received.push(row);
        }
        nextTail = [...nextTail, ...received];
        cursor = response.next_cursor;
        if (received.length > 0 && targetLength === undefined) break;
        if (targetLength !== undefined && nextTail.length >= targetLength) break;
    }
    return { rows: nextTail, nextCursor: cursor, pages };
}

export function canShowMoreSessions(total: number | undefined, shown: number, nextCursor: string | undefined): boolean {
    return total !== undefined && shown < total && nextCursor !== undefined;
}

export type SessionStatus = "idle" | "working" | "waiting" | "completed" | "other";

export interface SessionRow {
    readonly id: string;
    readonly name: string;
    // The folder the session works in; empty when the host sent none.
    readonly workspace: string;
    readonly status: SessionStatus;
    // Milliseconds since the epoch; absent when the host reported no usable time.
    readonly updatedAt?: number;
    readonly live: boolean;
    // A chat has no outside folder; its workspace is the session's own files folder.
    readonly chat: boolean;
    readonly archived?: boolean;
    readonly parentId?: string;
    readonly backgroundCommands?: number;
}

const KNOWN_STATUSES: readonly SessionStatus[] = ["idle", "working", "waiting", "completed"];

function statusOf(value: unknown): SessionStatus {
    return KNOWN_STATUSES.find((status) => status === value) ?? "other";
}

const SHORT_ID_LENGTH = 8;

// Rows the host sent in a shape this client does not read are skipped, not guessed at.
export function sessionRows(list: AgentListFacts): readonly SessionRow[] {
    const rows: SessionRow[] = [];
    for (const entry of list.agents) {
        if (typeof entry !== "object" || entry === null) continue;
        const fields = entry as Record<string, unknown>;
        if (typeof fields.id !== "string" || fields.id.length === 0) continue;
        const updated = typeof fields.updated_at === "string" ? Date.parse(fields.updated_at) : Number.NaN;
        rows.push({
            id: fields.id,
            name: displayName(fields),
            workspace: typeof fields.workspace === "string" ? fields.workspace : "",
            status: statusOf(fields.status),
            ...(Number.isFinite(updated) ? { updatedAt: updated } : {}),
            live: fields.live === true,
            archived: fields.archived === true,
            chat: fields.chat === true,
            ...(typeof fields.parent_id === "string" && fields.parent_id.length > 0 ? { parentId: fields.parent_id } : {}),
            ...(Number.isSafeInteger(fields.background_commands) && typeof fields.background_commands === "number" && fields.background_commands > 0
                ? { backgroundCommands: fields.background_commands }
                : {}),
        });
    }
    return rows;
}

// The title carries a rename; the identity name labels a session that has no title yet.
function displayName(fields: Record<string, unknown>): string {
    for (const candidate of [fields.title, fields.name]) {
        if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
    }
    return (fields.id as string).slice(0, SHORT_ID_LENGTH);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// A compact age for the list, such as "5m" or "2d"; `now` is a parameter so the result is testable.
export function relativeTime(updatedAt: number | undefined, now: number): string {
    if (updatedAt === undefined) return "";
    const elapsed = Math.max(0, now - updatedAt);
    if (elapsed < MINUTE) return "now";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
    if (elapsed < MONTH) return `${Math.floor(elapsed / DAY)}d`;
    if (elapsed < YEAR) return `${Math.floor(elapsed / MONTH)}mo`;
    return `${Math.floor(elapsed / YEAR)}y`;
}
