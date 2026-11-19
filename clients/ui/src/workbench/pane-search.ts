import type { RecentPage } from "../browser/recents.ts";

export function recentKey(item: RecentPage): string {
    return `${item.kind}:${item.target}`;
}

export function moveRecentSelection(items: readonly RecentPage[], selected: string | undefined, direction: 1 | -1): string | undefined {
    if (items.length === 0) return undefined;
    const index = selected === undefined ? -1 : items.findIndex((item) => recentKey(item) === selected);
    const next = index < 0 ? (direction === 1 ? 0 : items.length - 1) : (index + direction + items.length) % items.length;
    return recentKey(items[next]!);
}

export function selectedRecent(items: readonly RecentPage[], selected: string | undefined): RecentPage | undefined {
    return selected === undefined ? undefined : items.find((item) => recentKey(item) === selected);
}
