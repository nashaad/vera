import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface Toast {
    readonly id: number;
    readonly text: string;
    readonly tone: ToastTone;
}

// Older toasts leave first when more than this many are showing.
export const TOAST_LIMIT = 3;
export const TOAST_MS = 3_200;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: readonly Toast[]): void {
    toasts = next;
    for (const listener of listeners) listener();
}

// A short note that something finished. Anything the person must act on belongs in the page instead.
export function showToast(text: string, tone: ToastTone = "info"): number {
    const id = nextId;
    nextId += 1;
    set([...toasts, { id, text, tone }].slice(-TOAST_LIMIT));
    setTimeout(() => dismissToast(id), TOAST_MS);
    return id;
}

export function dismissToast(id: number): void {
    if (!toasts.some((toast) => toast.id === id)) return;
    set(toasts.filter((toast) => toast.id !== id));
}

export function currentToasts(): readonly Toast[] {
    return toasts;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useToasts(): readonly Toast[] {
    return useSyncExternalStore(subscribe, () => toasts);
}
