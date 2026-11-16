import { flushSync } from "react-dom";

import type { LayoutAction } from "../layout/reducer.ts";
import { canOpenTab, type ResolvedLayout } from "../layout/resolve.ts";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { chatTabs, type ChatSeed } from "./store.ts";

export const CHAT_CONTAINER = CORE_CONTAINERS.chat;

export const CHAT_TABS_FULL = "Close a Chat tab to open another.";

// What opening a Chat tab reads and changes; the workbench provides both.
export interface ChatTabHost {
    readonly layout: ResolvedLayout;
    readonly dispatch: (action: LayoutAction) => void;
}

export function newChatTabId(): string {
    return `tab.chat-${crypto.randomUUID().slice(0, 8)}`;
}

export function hasRoomForChatTab(host: ChatTabHost): boolean {
    return canOpenTab(host.layout, CHAT_CONTAINER);
}

// Opens a Chat tab on the session in `seed` and shows it, opening the right pane if it was closed. The entry is
// written first so the tab never draws without it. Undefined when the pane has no room. Not for use from a render or an effect.
export function openChatTab(host: ChatTabHost, seed: ChatSeed): string | undefined {
    if (!hasRoomForChatTab(host)) return undefined;
    const id = newChatTabId();
    if (chatTabs.add(id, seed) === undefined) return undefined;
    flushSync(() => host.dispatch({ type: "openTab", container: CHAT_CONTAINER, tab: id }));
    return id;
}

export function showChatTab(host: ChatTabHost, tab: string): void {
    host.dispatch({ type: "activateTab", tab });
}

export function closeChatTab(host: ChatTabHost, tab: string): void {
    host.dispatch({ type: "closeTab", tab });
}
