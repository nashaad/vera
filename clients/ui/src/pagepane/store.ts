import { useSyncExternalStore } from "react";

// The annex path, with its query, each open page tab shows. A tab with no entry shows its page bare.
let entries: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

function set(next: ReadonlyMap<string, string>): void {
    entries = next;
    for (const listener of listeners) listener();
}

export const pageTabs = {
    subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    snapshot: (): ReadonlyMap<string, string> => entries,
    get: (tab: string): string | undefined => entries.get(tab),
    show: (tab: string, path: string): void => {
        if (entries.get(tab) !== path) set(new Map(entries).set(tab, path));
    },
    drop: (tabs: readonly string[]): void => {
        if (!tabs.some((tab) => entries.has(tab))) return;
        const next = new Map(entries);
        for (const tab of tabs) next.delete(tab);
        set(next);
    },
    reset: (): void => set(new Map()),
};

export function usePageTabPath(tab: string | undefined): string | undefined {
    return useSyncExternalStore(pageTabs.subscribe, () => (tab === undefined ? undefined : entries.get(tab)));
}
