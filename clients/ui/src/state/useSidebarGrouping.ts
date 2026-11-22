import { useEffect, useSyncExternalStore } from "react";

import {
    DEFAULT_SIDEBAR_SETTINGS,
    parseSidebarSettings,
    type SidebarSettings,
} from "../protocol/sidebarSettings.ts";
import type { SidebarGrouping } from "../protocol/sidebarTree.ts";

let settings: SidebarSettings = DEFAULT_SIDEBAR_SETTINGS;
let loading: Promise<void> | undefined;
// A choice made before the file is read wins over the file.
let early: SidebarGrouping | undefined;
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: SidebarSettings): void {
    settings = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function load(): void {
    if (loading !== undefined) return;
    const bridge = window.veraDesktop;
    if (bridge === undefined) {
        loaded = true;
        loading = Promise.resolve();
        return;
    }
    loading = bridge.loadSidebarSettings()
        .then((saved) => parseSidebarSettings(saved) ?? DEFAULT_SIDEBAR_SETTINGS, () => DEFAULT_SIDEBAR_SETTINGS)
        .then((saved) => {
            loaded = true;
            const next = early === undefined ? saved : { groupBy: early };
            if (early !== undefined) bridge.saveSidebarSettings(next);
            early = undefined;
            publish(next);
        });
}

export function setSidebarGrouping(groupBy: SidebarGrouping): void {
    if (settings.groupBy === groupBy) return;
    const next: SidebarSettings = { groupBy };
    if (!loaded) early = groupBy;
    else window.veraDesktop?.saveSidebarSettings(next);
    publish(next);
}

export function useSidebarGrouping(): SidebarGrouping {
    useEffect(load, []);
    return useSyncExternalStore(subscribe, () => settings.groupBy);
}
