import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import type { CommandRegistry } from "../commands/registry.ts";
import { showToast } from "../overlays/toasts.ts";
import { useActiveSession } from "../session/activeSession.ts";
import { readFocusKeys } from "./context.ts";
import { createFrameLink } from "./sandbox/frame-worker.ts";
import { DesktopExtensionSystem } from "./system.ts";
import { desktopExtensionDiagnostics, desktopExtensionListingNote, desktopExtensions, subscribeDesktopExtensions } from "./state.ts";

export const ExtensionSystemContext = createContext<DesktopExtensionSystem | undefined>(undefined);

const TEST_KEY = "veraExtensionsTest";

// End-to-end checks can read worker states and stop a worker when this hook is enabled.
function exposeForTest(system: DesktopExtensionSystem): void {
    try {
        if (window.localStorage.getItem(TEST_KEY) !== "1") return;
    } catch {
        return;
    }
    Object.assign(window, {
        __veraExtensions: {
            states: () => system.runtime.snapshot(),
            failures: () => system.registry.snapshot().failures,
            conflicts: () => system.registry.snapshot().conflicts.length,
            stop: (extensionId: string) => system.runtime.stop(extensionId),
        },
    });
}

// The extension system of this window, or undefined outside the desktop shell. Registers contributions
// from the extensions folder and routes keys to bound extension commands. Nothing starts until a command runs.
export function useDesktopExtensions(commands: CommandRegistry): DesktopExtensionSystem | undefined {
    const bridge = window.veraDesktop;
    const system = useMemo(
        () => bridge === undefined
            ? undefined
            : new DesktopExtensionSystem({ commands, bridge, platform: bridge.platform, createLink: createFrameLink, toast: showToast }),
        [bridge, commands],
    );
    const session = useActiveSession();
    const hasSession = session !== undefined;
    const sessionBusy = session?.watch.status === "working";

    useEffect(() => system?.setSession({ hasSession, sessionBusy }), [system, hasSession, sessionBusy]);

    useEffect(() => {
        if (system === undefined) return undefined;
        const sync = (replacedId?: string): void => {
            const entries = desktopExtensions();
            if (entries !== undefined) system.sync(entries, replacedId, desktopExtensionDiagnostics(), desktopExtensionListingNote());
        };
        const unsubscribe = subscribeDesktopExtensions(sync);
        sync();
        exposeForTest(system);
        const onKey = (event: KeyboardEvent): void => {
            if (system.handleKey(event) === undefined) return;
            event.preventDefault();
            event.stopPropagation();
        };
        const onFocus = (event: Event): void => {
            const keys = event.target instanceof Element ? readFocusKeys(event.target) : undefined;
            if (keys !== undefined) system.setFocus(keys);
        };
        const dispose = (): void => system.dispose();
        window.addEventListener("keydown", onKey, true);
        document.addEventListener("focusin", onFocus, true);
        document.addEventListener("pointerdown", onFocus, true);
        window.addEventListener("pagehide", dispose);
        return () => {
            unsubscribe();
            window.removeEventListener("keydown", onKey, true);
            document.removeEventListener("focusin", onFocus, true);
            document.removeEventListener("pointerdown", onFocus, true);
            window.removeEventListener("pagehide", dispose);
            dispose();
        };
    }, [system]);

    return system;
}

const NEVER = (): (() => void) => () => undefined;
const NO_TOKEN = (): object => EMPTY;
const EMPTY = {};

// A function that says whether a command shows in the palette. It changes when a context key or a contribution changes.
export function useCommandVisibility(): (commandId: string) => boolean {
    const system = useContext(ExtensionSystemContext);
    const token = useSyncExternalStore(system?.subscribe ?? NEVER, system?.token ?? NO_TOKEN);
    return useCallback((commandId: string) => system === undefined || system.isVisible(commandId), [system, token]);
}
