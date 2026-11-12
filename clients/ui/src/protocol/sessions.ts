import type { AgentListFacts } from "./client.ts";

// The sessions list shows one page; the session count comes from the host's total.
export const SESSIONS_PAGE_SIZE = 50;

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
    readonly parentId?: string;
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
            ...(typeof fields.parent_id === "string" && fields.parent_id.length > 0 ? { parentId: fields.parent_id } : {}),
        });
    }
    return rows;
}

function displayName(fields: Record<string, unknown>): string {
    for (const candidate of [fields.name, fields.title]) {
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
