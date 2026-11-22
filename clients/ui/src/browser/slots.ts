import { useSyncExternalStore } from "react";

import type { BrowserState } from "./native-types.ts";

// The slot of a Browser view that is not a right pane tab, such as one moved to the panel.
export const CONTAINER_SLOT = "container";

export interface Slot {
    // The shell page this slot shows, if one has been opened.
    readonly page: number | undefined;
}

export interface SlotStore {
    readonly slots: ReadonlyMap<string, Slot>;
    // The shell's pages as last read; none until the first read.
    readonly native: BrowserState | undefined;
    // Open requests in flight. While any is, the slots and the pages are not compared.
    readonly claims: number;
}

export const EMPTY_SLOT: Slot = { page: undefined };

const EMPTY_STORE: SlotStore = { slots: new Map(), native: undefined, claims: 0 };

let store: SlotStore = EMPTY_STORE;
const listeners = new Set<() => void>();

function set(next: SlotStore): void {
    if (next === store) return;
    store = next;
    for (const listener of listeners) listener();
}

function withSlot(key: string, change: Partial<Slot>): void {
    const current = store.slots.get(key) ?? EMPTY_SLOT;
    const next = { ...current, ...change };
    if (next.page === current.page && store.slots.has(key)) return;
    set({ ...store, slots: new Map(store.slots).set(key, next) });
}

export const browserSlots = {
    get: (): SlotStore => store,
    subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    slot: (key: string): Slot => store.slots.get(key) ?? EMPTY_SLOT,
    bind: (key: string, page: number): void => withSlot(key, { page }),
    unbind: (key: string): void => withSlot(key, { page: undefined }),
    drop: (keys: readonly string[]): void => {
        if (!keys.some((key) => store.slots.has(key))) return;
        const slots = new Map(store.slots);
        for (const key of keys) slots.delete(key);
        set({ ...store, slots });
    },
    // Replaces what is known of the pages; an equal read changes nothing.
    read: (native: BrowserState): void => {
        if (store.native !== undefined && JSON.stringify(store.native) === JSON.stringify(native)) return;
        set({ ...store, native });
    },
    claim: (): void => set({ ...store, claims: store.claims + 1 }),
    release: (): void => set({ ...store, claims: Math.max(0, store.claims - 1) }),
    reset: (): void => set(EMPTY_STORE),
};

export function useSlotStore(): SlotStore {
    return useSyncExternalStore(browserSlots.subscribe, browserSlots.get, browserSlots.get);
}

export function useSlot(key: string): Slot {
    const current = useSlotStore();
    return current.slots.get(key) ?? EMPTY_SLOT;
}
