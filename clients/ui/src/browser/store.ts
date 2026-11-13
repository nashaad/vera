import { useSyncExternalStore } from "react";

import { browse, START, step, type BrowserHistory } from "./address.ts";

// The right pane browser's history lives for the window, so the palette and slash commands can
// open a page in it before the view is ever shown.
let history: BrowserHistory = START;
const listeners = new Set<() => void>();

function set(next: BrowserHistory): void {
    if (next === history) return;
    history = next;
    for (const listener of listeners) listener();
}

export const browserHistory = {
    get: (): BrowserHistory => history,
    browse: (entry: string): void => set(browse(history, entry)),
    step: (by: -1 | 1): void => set(step(history, by)),
    subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};

export function useBrowserHistory(): BrowserHistory {
    return useSyncExternalStore(browserHistory.subscribe, browserHistory.get);
}
