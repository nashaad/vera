import { useSyncExternalStore } from "react";

import type { Overlay } from "../commands/overlay-ids.ts";

export type { Overlay };

let open: Overlay | undefined;
let screenshot: string | undefined;
let generation = 0;

export function feedbackScreenshot(): string | undefined { return screenshot; }
const listeners = new Set<() => void>();

function set(next: Overlay | undefined): void {
    if (next === open) return;
    open = next;
    for (const listener of listeners) listener();
}

export function openOverlay(overlay: Overlay): void {
    const current = ++generation;
    if (overlay !== "feedback") { set(overlay); return; }
    set(undefined);
    screenshot = undefined;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        void (window.veraDesktop?.captureFeedback() ?? Promise.resolve(undefined)).catch(() => undefined).then((image) => {
            if (generation !== current) return;
            screenshot = image;
            set("feedback");
        });
    }));
}

export function closeOverlay(): void {
    generation++;
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
