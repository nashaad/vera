import { useSyncExternalStore } from "react";

import type { Overlay } from "../commands/overlay-ids.ts";

export type { Overlay };

let open: Overlay | undefined;
const listeners = new Set<() => void>();

function set(next: Overlay | undefined): void {
    if (next === open) return;
    open = next;
    for (const listener of listeners) listener();
}

export function openOverlay(overlay: Overlay): void {
    set(overlay);
}

export function closeOverlay(): void {
    set(undefined);
}

export function openedOverlay(): Overlay | undefined {
    return open;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useOverlay(): Overlay | undefined {
    return useSyncExternalStore(subscribe, () => open);
}
