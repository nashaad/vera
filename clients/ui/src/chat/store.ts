import { useSyncExternalStore } from "react";

import { CHAT_PANE_LIMIT, chatPane, type ChatPane } from "../protocol/panes.ts";

export type ChatKind = "help" | "sidekick";

export interface ChatEntry {
    readonly kind: ChatKind;
    readonly agentId: string;
    // The watch pane this tab uses; no two open Chat tabs share one.
    readonly pane: ChatPane;
    // The tab's title until the session names itself.
    readonly title: string;
    readonly folder: string | undefined;
    readonly chat: boolean;
    // The session a sidekick was branched from.
    readonly primary?: string;
}

export type ChatSeed = Omit<ChatEntry, "pane">;

let entries: ReadonlyMap<string, ChatEntry> = new Map();
const listeners = new Set<() => void>();

function set(next: ReadonlyMap<string, ChatEntry>): void {
    entries = next;
    for (const listener of listeners) listener();
}

function freePane(): ChatPane | undefined {
    const used = new Set([...entries.values()].map((entry) => entry.pane));
    for (let slot = 0; slot < CHAT_PANE_LIMIT; slot += 1) {
        const pane = chatPane(slot);
        if (!used.has(pane)) return pane;
    }
    return undefined;
}

// What each open Chat tab shows, by tab id. Closing a tab drops its entry and frees its pane.
export const chatTabs = {
    subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    snapshot: (): ReadonlyMap<string, ChatEntry> => entries,
    get: (tab: string): ChatEntry | undefined => entries.get(tab),
    // Undefined when every pane is taken.
    add: (tab: string, seed: ChatSeed): ChatEntry | undefined => {
        const pane = freePane();
        if (pane === undefined) return undefined;
        const entry: ChatEntry = { ...seed, pane };
        set(new Map(entries).set(tab, entry));
        return entry;
    },
    // Points a tab at another session; its pane stays.
    retarget: (tab: string, agentId: string): void => {
        const current = entries.get(tab);
        if (current === undefined || current.agentId === agentId) return;
        set(new Map(entries).set(tab, { ...current, agentId }));
    },
    drop: (tabs: readonly string[]): void => {
        if (!tabs.some((tab) => entries.has(tab))) return;
        const next = new Map(entries);
        for (const tab of tabs) next.delete(tab);
        set(next);
    },
    // The tab holding the sidekick of a session, if it has one open.
    sidekickOf: (primary: string): { readonly tab: string; readonly entry: ChatEntry } | undefined => {
        for (const [tab, entry] of entries) {
            if (entry.kind === "sidekick" && entry.primary === primary) return { tab, entry };
        }
        return undefined;
    },
    reset: (): void => set(new Map()),
};

export function useChatEntry(tab: string | undefined): ChatEntry | undefined {
    return useSyncExternalStore(chatTabs.subscribe, () => (tab === undefined ? undefined : entries.get(tab)));
}
