import { useSyncExternalStore } from "react";
import { browserUrl, URL_LIMIT } from "./url.ts";

export const RECENT_LIMIT = 20;
export const RECENT_TITLE_LIMIT = 200;
export const RECENT_STORAGE_KEY = "vera.desktop.pane-recents";

export interface RecentPage {
    readonly kind: "browser" | "annex";
    readonly target: string;
    readonly title: string;
}

export function parseRecent(value: unknown): RecentPage | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if ((item.kind !== "browser" && item.kind !== "annex") || typeof item.target !== "string" || typeof item.title !== "string") return undefined;
    if (item.target.length === 0 || item.target.length > URL_LIMIT || item.title.length === 0 || item.title.length > RECENT_TITLE_LIMIT) return undefined;
    if (item.kind === "browser") {
        if (!/^https?:\/\//i.test(item.target) || browserUrl(item.target) !== item.target) return undefined;
    } else if (!item.target.startsWith("/") || item.target.startsWith("//") || /[\u0000-\u001f]/.test(item.target)) return undefined;
    return { kind: item.kind, target: item.target, title: item.title };
}

export function parseRecents(value: unknown): RecentPage[] {
    if (!Array.isArray(value)) return [];
    const result: RecentPage[] = [];
    for (const entry of value.slice(0, RECENT_LIMIT)) {
        const item = parseRecent(entry);
        if (item !== undefined && !result.some((current) => current.kind === item.kind && current.target === item.target)) result.push(item);
    }
    return result;
}

export function addRecent(items: readonly RecentPage[], item: RecentPage): RecentPage[] {
    const parsed = parseRecent(item);
    if (parsed === undefined) return items.slice(0, RECENT_LIMIT);
    return [parsed, ...items.filter((current) => current.kind !== parsed.kind || current.target !== parsed.target)].slice(0, RECENT_LIMIT);
}

export function readRecents(storage: Storage): RecentPage[] {
    try {
        const value = storage.getItem(RECENT_STORAGE_KEY);
        if (value === null || value.length > RECENT_LIMIT * (URL_LIMIT + RECENT_TITLE_LIMIT + 100)) return [];
        return parseRecents(JSON.parse(value));
    } catch { return []; }
}

export function writeRecents(storage: Storage, items: readonly RecentPage[]): void {
    try { storage.setItem(RECENT_STORAGE_KEY, JSON.stringify(parseRecents(items))); } catch { return; }
}

let current: readonly RecentPage[] | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
    try { return window.localStorage; } catch { return undefined; }
}

function snapshot(): readonly RecentPage[] {
    if (current === undefined) {
        const saved = storage();
        current = saved === undefined ? [] : readRecents(saved);
    }
    return current;
}

function publish(items: readonly RecentPage[]): void {
    current = items;
    const saved = storage();
    if (saved !== undefined) writeRecents(saved, items);
    for (const listener of listeners) listener();
}

export function recordRecent(item: RecentPage): void {
    publish(addRecent(snapshot(), item));
}

export function useRecents(): readonly RecentPage[] {
    return useSyncExternalStore((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }, snapshot);
}
