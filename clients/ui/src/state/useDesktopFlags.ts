import { useEffect, useSyncExternalStore } from "react";

import { DEFAULT_DESKTOP_FLAGS, parseFlags, type DesktopFlags } from "./desktopFlags.ts";

interface FlagsState {
    readonly loaded: boolean;
    readonly flags: DesktopFlags;
}

let state: FlagsState = { loaded: false, flags: DEFAULT_DESKTOP_FLAGS };
const listeners = new Set<() => void>();

function publish(next: FlagsState): void {
    state = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function currentDesktopFlags(): DesktopFlags {
    return state.flags;
}

export function setDesktopFlags(flags: DesktopFlags): void {
    publish({ loaded: true, flags });
}

export function resetDesktopFlags(): void {
    publish({ loaded: false, flags: DEFAULT_DESKTOP_FLAGS });
}

export function useDesktopFlags(): DesktopFlags {
    return useSyncExternalStore(subscribe, () => state.flags);
}

// Reads the flags once when the window opens; false until they are in, so the first draw never shows then hides reasoning.
export function useDesktopFlagsLoaded(): boolean {
    const loaded = useSyncExternalStore(subscribe, () => state.loaded);
    useEffect(() => {
        let cancelled = false;
        const bridge = window.veraDesktop;
        const read = bridge === undefined ? Promise.resolve(DEFAULT_DESKTOP_FLAGS) : bridge.loadFlags();
        read.catch(() => DEFAULT_DESKTOP_FLAGS).then((flags) => {
            if (!cancelled) setDesktopFlags(parseFlags(flags));
        });
        return () => {
            cancelled = true;
        };
    }, []);
    return loaded;
}
