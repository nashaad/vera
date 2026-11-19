import { useEffect, useSyncExternalStore } from "react";

import { showToast } from "../overlays/toasts.ts";
import { DEFAULT_DESKTOP_FLAGS, parseFlags, type DesktopFlags, type FlagChoice, type FlagKey } from "./desktopFlags.ts";

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

export function subscribeDesktopFlags(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

const subscribe = subscribeDesktopFlags;

export function currentDesktopFlags(): DesktopFlags {
    return state.flags;
}

export function setDesktopFlags(flags: DesktopFlags): void {
    publish({ loaded: true, flags });
}

export function resetDesktopFlags(): void {
    publish({ loaded: false, flags: DEFAULT_DESKTOP_FLAGS });
}

// The choice shows at once and is written to the file; if the write fails the previous choice comes back.
export async function chooseDesktopFlag(key: FlagKey, choice: FlagChoice): Promise<void> {
    const before = state.flags;
    if (before[key] === choice) return;
    publish({ loaded: state.loaded, flags: { ...before, [key]: choice } });
    const bridge = window.veraDesktop;
    if (bridge === undefined) return;
    const saved = await bridge.saveFlags({ [key]: choice }).catch(() => undefined);
    if (saved === undefined) {
        publish({ loaded: state.loaded, flags: { ...state.flags, [key]: before[key] } });
        showToast("The change could not be saved", "danger");
        return;
    }
    publish({ loaded: state.loaded, flags: parseFlags(saved, before) });
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
