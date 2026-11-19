import { useSyncExternalStore } from "react";

import type { Overlay } from "../commands/overlay-ids.ts";
import type { CommandPickItem } from "../protocol/extension-commands.ts";

export type { Overlay };

// A list an extension command asked the person to choose from. It is not an `Overlay`: it has no command of its own.
export interface PickerRequest {
    readonly title: string;
    readonly items: readonly CommandPickItem[];
    readonly cut: boolean;
    readonly choose: (key: string) => void;
}

let open: Overlay | undefined;
let picker: PickerRequest | undefined;
let screenshot: string | undefined;
let generation = 0;

export function feedbackScreenshot(): string | undefined { return screenshot; }
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

function set(next: Overlay | undefined): void {
    if (next === open) return;
    open = next;
    if (next !== undefined) picker = undefined;
    emit();
}

// One thing is open at a time, so the picker replaces an open overlay and an overlay replaces the picker.
export function openPicker(request: PickerRequest): void {
    generation++;
    open = undefined;
    picker = request;
    emit();
}

export function closePicker(): void {
    if (picker === undefined) return;
    picker = undefined;
    emit();
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
    closePicker();
    set(undefined);
}

export function openedOverlay(): Overlay | undefined {
    return open;
}

export function openedPicker(): PickerRequest | undefined {
    return picker;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useOverlay(): Overlay | undefined {
    return useSyncExternalStore(subscribe, () => open);
}

export function usePicker(): PickerRequest | undefined {
    return useSyncExternalStore(subscribe, () => picker);
}
