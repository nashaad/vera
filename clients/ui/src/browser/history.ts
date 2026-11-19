import { clearBrowserRecents } from "./recents.ts";
import { browserUrl, URL_LIMIT } from "./url.ts";

export const HISTORY_STORAGE_KEY = "vera.desktop.browser-history";
export const HISTORY_PAGE_SIZE = 50;
const HISTORY_LIMIT = 500;
const HISTORY_TITLE_LIMIT = 200;
const HISTORY_STORAGE_SIZE_LIMIT = 1024 * 1024;

export interface HistoryEntry {
    readonly url: string;
    readonly title: string;
    readonly visitedAt: number;
}

export interface HistoryPage {
    readonly entries: readonly HistoryEntry[];
    readonly hasMore: boolean;
}

const listeners = new Set<() => void>();
let version = 0;

function storage(): Storage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return typeof item.url === "string"
        && item.url.length > 0
        && item.url.length <= URL_LIMIT
        && /^https?:\/\//i.test(item.url)
        && browserUrl(item.url) === item.url
        && typeof item.title === "string"
        && item.title.length > 0
        && item.title.length <= HISTORY_TITLE_LIMIT
        && typeof item.visitedAt === "number"
        && Number.isFinite(item.visitedAt)
        && item.visitedAt >= 0
        && Number.isFinite(new Date(item.visitedAt).getTime());
}

function readHistory(source: Storage | undefined = storage()): HistoryEntry[] {
    if (source === undefined) return [];
    try {
        const saved = source.getItem(HISTORY_STORAGE_KEY);
        if (saved === null || saved.length > HISTORY_STORAGE_SIZE_LIMIT) return [];
        const parsed: unknown = JSON.parse(saved);
        if (!Array.isArray(parsed) || parsed.length > HISTORY_LIMIT) return [];
        const entries: HistoryEntry[] = [];
        let priorTime = Number.POSITIVE_INFINITY;
        for (const item of parsed) {
            if (!isHistoryEntry(item) || item.visitedAt > priorTime) return [];
            priorTime = item.visitedAt;
            entries.push({ url: item.url, title: item.title, visitedAt: item.visitedAt });
        }
        return entries;
    } catch {
        return [];
    }
}

function writeHistory(entries: readonly HistoryEntry[], target: Storage): void {
    let serializedSize = 2;
    let keepCount = 0;
    for (const entry of entries.slice(0, HISTORY_LIMIT)) {
        const entrySize = JSON.stringify(entry).length;
        const nextSize = serializedSize + entrySize + (keepCount === 0 ? 0 : 1);
        if (nextSize > HISTORY_STORAGE_SIZE_LIMIT) break;
        serializedSize = nextSize;
        keepCount++;
    }
    target.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, keepCount)));
}

function publish(): void {
    version++;
    for (const listener of listeners) listener();
}

export function recordVisit(url: string, title: string): void {
    const entry = { url, title, visitedAt: Date.now() };
    if (!isHistoryEntry(entry)) return;
    const target = storage();
    if (target === undefined) return;
    const previous = readHistory(target);
    const visitedAt = Math.max(entry.visitedAt, previous[0]?.visitedAt ?? 0);
    const visit = { ...entry, visitedAt };
    const next = previous[0]?.url === url ? previous.slice(1) : previous;
    try {
        writeHistory([visit, ...next], target);
        publish();
    } catch {
        return;
    }
}

export function listVisits(query: string, offset: number): HistoryPage {
    const needle = query.toLocaleLowerCase();
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const entries: HistoryEntry[] = [];
    let matchCount = 0;
    for (const entry of readHistory()) {
        if (!entry.title.toLocaleLowerCase().includes(needle)
            && !entry.url.toLocaleLowerCase().includes(needle)) continue;
        if (matchCount >= start && entries.length < HISTORY_PAGE_SIZE + 1) entries.push(entry);
        matchCount++;
        if (entries.length > HISTORY_PAGE_SIZE) break;
    }
    const hasMore = entries.length > HISTORY_PAGE_SIZE;
    if (hasMore) entries.pop();
    return { entries, hasMore };
}

export function clearHistory(): void {
    const target = storage();
    if (target !== undefined) {
        try {
            target.removeItem(HISTORY_STORAGE_KEY);
        } catch {
            // Storage can be unavailable while in-memory recents still need clearing.
        }
    }
    clearBrowserRecents();
    publish();
}

export function subscribeHistory(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function historyVersion(): number {
    return version;
}
