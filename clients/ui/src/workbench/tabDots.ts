import { useSyncExternalStore } from "react";

// The pane kinds that changed while none of their tabs was shown. Per window, never saved.
let marked: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function set(next: ReadonlySet<string>): void {
    marked = next;
    for (const listener of listeners) listener();
}

export const tabDots = {
    subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    snapshot: (): ReadonlySet<string> => marked,
    mark: (kind: string): void => {
        if (!marked.has(kind)) set(new Set(marked).add(kind));
    },
    clear: (kinds: readonly string[]): void => {
        if (!kinds.some((kind) => marked.has(kind))) return;
        set(new Set([...marked].filter((kind) => !kinds.includes(kind))));
    },
    reset: (): void => set(new Set()),
};

export function useTabDot(kind: string): boolean {
    return useSyncExternalStore(tabDots.subscribe, () => marked.has(kind));
}

export function useAnyTabDot(): boolean {
    return useSyncExternalStore(tabDots.subscribe, () => marked.size > 0);
}

export function useMarkedKinds(): ReadonlySet<string> {
    return useSyncExternalStore(tabDots.subscribe, tabDots.snapshot);
}
