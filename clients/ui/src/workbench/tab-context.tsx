import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

// The id of the right pane tab a view is drawn for; absent for a view in any other location.
export const PaneTabContext = createContext<string | undefined>(undefined);

export function usePaneTab(): string | undefined {
    return useContext(PaneTabContext);
}

type Titles = Readonly<Record<string, string>>;

let titles: Titles = {};
const listeners = new Set<() => void>();

function setTitle(tab: string, title: string | undefined): void {
    if (titles[tab] === title) return;
    if (title === undefined) {
        const { [tab]: _gone, ...rest } = titles;
        titles = rest;
    } else {
        titles = { ...titles, [tab]: title };
    }
    for (const listener of listeners) listener();
}

// What the tab strip shows for a tab in place of its kind's title; a view sets it for its own tab.
export function useTabTitle(tab: string): string | undefined {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => titles[tab],
    );
}

export function usePublishTabTitle(title: string | undefined): void {
    const tab = usePaneTab();
    useEffect(() => {
        if (tab === undefined) return;
        setTitle(tab, title !== undefined && title.trim() !== "" ? title : undefined);
        return () => setTitle(tab, undefined);
    }, [tab, title]);
}
