import { useSyncExternalStore } from "react";

export type SessionSheet = "rewind" | "tasks" | "subagents" | "rename";

let open: SessionSheet | undefined;
const listeners = new Set<() => void>();

function set(next: SessionSheet | undefined): void {
    if (next === open) return;
    open = next;
    for (const listener of listeners) listener();
}

export function openSessionSheet(sheet: SessionSheet): void {
    set(sheet);
}

export function closeSessionSheet(): void {
    set(undefined);
}

export function openedSessionSheet(): SessionSheet | undefined {
    return open;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useSessionSheet(): SessionSheet | undefined {
    return useSyncExternalStore(subscribe, () => open);
}
