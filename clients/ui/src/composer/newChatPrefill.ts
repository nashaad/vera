import { useSyncExternalStore } from "react";

interface PendingPrefill {
    readonly id: number;
    readonly text: string;
}

let pending: PendingPrefill | undefined;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

// A prefill never replaces a typed draft: the command goes first, then the draft, so the user's text is kept.
export function mergeNewChatPrefill(draft: string, prefill: string): string {
    return draft.trim().length === 0 ? prefill : `${prefill} ${draft}`;
}

// A page asks the next new-chat composer to start with this text. The composer takes it once and owns it after that.
export function requestNewChatPrefill(text: string): void {
    pending = { id: nextId, text };
    nextId += 1;
    emit();
}

export function takeNewChatPrefill(id: number): string | undefined {
    if (pending?.id !== id) return undefined;
    const text = pending.text;
    pending = undefined;
    emit();
    return text;
}

export function useNewChatPrefill(): PendingPrefill | undefined {
    return useSyncExternalStore(subscribe, () => pending, () => undefined);
}
