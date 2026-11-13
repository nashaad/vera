import { useEffect, useSyncExternalStore } from "react";

import { NO_PINS, parsePins, togglePin, type SavedPins } from "../protocol/pins.ts";

let pins: SavedPins = NO_PINS;
let loading: Promise<void> | undefined;
// Toggles made before the file is read are replayed over what it holds.
let early: string[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: SavedPins): void {
    pins = next;
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
    loading = bridge.loadPins()
        .then((saved) => parsePins(saved) ?? NO_PINS, () => NO_PINS)
        .then((saved) => {
            loaded = true;
            const replayed = early.reduce(togglePin, saved);
            if (early.length > 0) bridge.savePins(replayed);
            early = [];
            publish(replayed);
        });
}

export function isPinned(id: string): boolean {
    return pins.sessions.includes(id);
}

export function toggleSessionPin(id: string): void {
    const next = togglePin(pins, id);
    if (!loaded) early.push(id);
    else window.veraDesktop?.savePins(next);
    publish(next);
}

export function usePinnedSessions(): readonly string[] {
    useEffect(load, []);
    return useSyncExternalStore(subscribe, () => pins.sessions);
}
