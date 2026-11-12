import { useSyncExternalStore } from "react";

// Whether the approval menus offer Full access. Off until it is turned on in Settings > Approvals,
// kept in this window's storage, which lives in the home.
const STORAGE_KEY = "vera.full-access";

type FlagStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): FlagStorage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

export function readFullAccessOffered(storage: FlagStorage | undefined = defaultStorage()): boolean {
    try {
        return storage?.getItem(STORAGE_KEY) === "on";
    } catch {
        return false;
    }
}

export function storeFullAccessOffered(on: boolean, storage: FlagStorage | undefined = defaultStorage()): void {
    try {
        storage?.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
        // Storage can be unavailable in a sandboxed renderer; the choice still applies until reload.
    }
}

let offered: boolean | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function fullAccessOffered(): boolean {
    offered ??= readFullAccessOffered();
    return offered;
}

export function offerFullAccess(on: boolean): void {
    offered = on;
    storeFullAccessOffered(on);
    for (const listener of listeners) listener();
}

export function useFullAccessOffered(): boolean {
    return useSyncExternalStore(subscribe, fullAccessOffered);
}
