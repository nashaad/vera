import { flushSync } from "react-dom";

import type { LayoutAction } from "../layout/reducer.ts";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { nativeCommand } from "./native.ts";
import { browserSlots } from "./slots.ts";

export const BROWSER_CONTAINER = CORE_CONTAINERS.browser;

type Dispatch = (action: LayoutAction) => void;

// The caller names a Browser tab so it can fill the tab's slot before the tab is drawn.
export function newBrowserTabId(): string {
    return `tab.page-${crypto.randomUUID().slice(0, 8)}`;
}

// Not for use from a render or an effect.
export function openBrowserTab(dispatch: Dispatch, seed: { readonly page?: number }): string {
    const id = newBrowserTabId();
    browserSlots.claim();
    try {
        flushSync(() => dispatch({ type: "openTab", container: BROWSER_CONTAINER, tab: id }));
        if (seed.page !== undefined) browserSlots.bind(id, seed.page);
    } finally {
        browserSlots.release();
    }
    return id;
}

// Opens a web address in a new Browser tab. The tab exists only when the shell opened the page.
export async function openAddressInTab(dispatch: Dispatch, address: string): Promise<void> {
    browserSlots.claim();
    try {
        const answer = await nativeCommand("open", address);
        if (answer?.opened === undefined) return;
        const id = newBrowserTabId();
        flushSync(() => dispatch({ type: "openTab", container: BROWSER_CONTAINER, tab: id }));
        browserSlots.bind(id, answer.opened);
    } finally {
        browserSlots.release();
    }
}

// Opens a web address in an empty slot.
export async function openAddressIn(key: string, address: string): Promise<void> {
    browserSlots.claim();
    try {
        const answer = await nativeCommand("open", address);
        if (answer?.opened !== undefined) browserSlots.bind(key, answer.opened);
    } finally {
        browserSlots.release();
    }
}
