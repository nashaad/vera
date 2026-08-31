import type { UsageSessionRow } from "../../src/host/usage-report.ts";

export const SESSION_PAGE_SIZE = 25;

export type SessionSortKey =
    | "title"
    | "workspace"
    | "kind"
    | "calls"
    | "own"
    | "children"
    | "cost";

export type SortDir = "asc" | "desc";

export interface SessionSort {
    readonly key: SessionSortKey;
    readonly dir: SortDir;
}

export const DEFAULT_SESSION_SORT: SessionSort = { key: "cost", dir: "desc" };

const NUMERIC = new Set<SessionSortKey>(["calls", "own", "children", "cost"]);

export function nextSessionSort(
    current: SessionSort,
    key: SessionSortKey,
): SessionSort {
    if (current.key === key) {
        return { key, dir: current.dir === "asc" ? "desc" : "asc" };
    }
    return { key, dir: NUMERIC.has(key) ? "desc" : "asc" };
}

export interface PageSlice<T> {
    readonly page: number;
    readonly pages: number;
    readonly rows: readonly T[];
    readonly from: number;
    readonly to: number;
    readonly total: number;
}

export function pageSlice<T>(
    rows: readonly T[],
    page: number,
    pageSize: number,
): PageSlice<T> {
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const clamped = Math.min(Math.max(0, page), pages - 1);
    const start = clamped * pageSize;
    const end = Math.min(start + pageSize, rows.length);
    return {
        page: clamped,
        pages,
        rows: rows.slice(start, end),
        from: rows.length === 0 ? 0 : start + 1,
        to: end,
        total: rows.length,
    };
}

export function modelQueryMatches(modelId: string, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return true;
    return modelId.toLowerCase().includes(needle);
}

export function sessionMatchesModelQuery(
    models: readonly string[],
    query: string,
): boolean {
    if (query.trim().length === 0) return true;
    return models.some((id) => modelQueryMatches(id, query));
}

export function sessionMatchesModelFilter(
    models: readonly string[],
    query: string,
    pin: string | undefined,
): boolean {
    if (pin !== undefined && pin.length > 0) {
        return models.includes(pin);
    }
    return sessionMatchesModelQuery(models, query);
}

export function modelListQuery(query: string, pin: string | undefined): string {
    if (pin !== undefined && query === pin) return "";
    return query;
}

export function sortSessions(
    rows: readonly UsageSessionRow[],
    sort: SessionSort,
): UsageSessionRow[] {
    return [...rows].sort((left, right) => compareSessions(left, right, sort));
}

function compareSessions(
    left: UsageSessionRow,
    right: UsageSessionRow,
    sort: SessionSort,
): number {
    const mul = sort.dir === "asc" ? 1 : -1;
    const primary = compareValues(
        sortValue(left, sort.key),
        sortValue(right, sort.key),
    );
    if (primary !== 0) return mul * primary;
    const recency = right.updatedAt.localeCompare(left.updatedAt);
    if (recency !== 0) return recency;
    return left.id.localeCompare(right.id);
}

function compareValues(left: string | number, right: string | number): number {
    if (typeof left === "number" && typeof right === "number") {
        return left - right;
    }
    return String(left).localeCompare(String(right), undefined, {
        sensitivity: "base",
    });
}

function sortValue(
    row: UsageSessionRow,
    key: SessionSortKey,
): string | number {
    switch (key) {
        case "title":
            return row.title;
        case "workspace":
            return row.workspaceLabel;
        case "kind":
            return row.kind === "subagent" ? "sub" : "chat";
        case "calls":
            return row.calls;
        case "own":
            return row.own;
        case "children":
            return row.children;
        case "cost":
            return row.combined;
    }
}
