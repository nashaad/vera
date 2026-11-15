import { useEffect, useMemo, useRef } from "react";
import { flushSync } from "react-dom";

import { MAX_TABS } from "../layout/model.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { revealContainer } from "../workbench/reveal.ts";
import { nativeCommand } from "./native.ts";
import { BROWSER_CONTAINER, newBrowserTabId } from "./open.ts";
import { reconcile, type ReconcilePlan } from "./reconcile.ts";
import { browserSlots, CONTAINER_SLOT, useSlotStore } from "./slots.ts";

const POLL_MS = 500;

function hasWork(plan: ReconcilePlan): boolean {
    return plan.closeSlots.length + plan.adopt.length + plan.closePages.length + plan.dropSlots.length > 0;
}

// Keeps the right pane's Browser tabs and the shell's pages one to one: a tab whose page is gone closes,
// a page opened from outside a tab (a popup, an agent tool) gets a tab, and a page whose tab closed closes.
export function BrowserSync() {
    const workbench = useWorkbench();
    const { layout, dispatch } = workbench;
    const latest = useRef(workbench);
    latest.current = workbench;
    const store = useSlotStore();
    const queue = useRef<Promise<void>>(Promise.resolve());

    const placed = layout.containers.find((container) => container.id === BROWSER_CONTAINER);
    const inPane = placed !== undefined && placed.shown && placed.location === "rightPane";
    const tabs = layout.locations.rightPane.tabs.filter((tab) => tab.container.id === BROWSER_CONTAINER);
    const tabKey = tabs.map((tab) => tab.id).join(" ");
    const live = useMemo(() => [
        ...(tabKey === "" ? [] : tabKey.split(" ")),
        ...(placed !== undefined && placed.shown && placed.location !== "rightPane" ? [CONTAINER_SLOT] : []),
    ], [tabKey, placed]);
    const room = inPane && placed !== undefined
        ? Math.max(0, Math.min((placed.maxTabs ?? MAX_TABS) - placed.tabCount, MAX_TABS - layout.tabTotal))
        : 0;

    const run = async (): Promise<void> => {
        const held = browserSlots.get();
        if (held.native === undefined || held.claims > 0) return;
        const bound: Record<string, number | undefined> = {};
        for (const [key, slot] of held.slots) bound[key] = slot.page;
        const plan = reconcile({
            live,
            bound,
            pages: held.native.tabs.map((page) => page.id),
            active: held.native.active,
            room,
        });
        if (!hasWork(plan)) return;
        browserSlots.claim();
        try {
            for (const page of plan.closePages) await nativeCommand("close", page);
            for (const key of plan.closeSlots) {
                if (key === CONTAINER_SLOT) browserSlots.unbind(key);
                else flushSync(() => latest.current.dispatch({ type: "closeTab", tab: key }));
            }
            for (const page of plan.adopt) {
                const id = newBrowserTabId();
                flushSync(() => latest.current.dispatch({ type: "openTab", container: BROWSER_CONTAINER, tab: id }));
                browserSlots.bind(id, page);
            }
            browserSlots.drop(plan.dropSlots.filter((key) => key !== CONTAINER_SLOT || !live.includes(CONTAINER_SLOT)));
        } finally {
            browserSlots.release();
        }
    };
    const runRef = useRef(run);
    runRef.current = run;
    const sync = (): Promise<void> => {
        queue.current = queue.current.then(() => runRef.current(), () => runRef.current());
        return queue.current;
    };
    const syncRef = useRef(sync);
    syncRef.current = sync;

    useEffect(() => {
        void syncRef.current();
    }, [store, live, room]);

    useEffect(() => {
        void nativeCommand("state");
    }, []);

    const polling = live.length > 0;
    useEffect(() => {
        if (!polling) return;
        const timer = window.setInterval(() => void nativeCommand("state"), POLL_MS);
        return () => window.clearInterval(timer);
    }, [polling]);

    // The agent used the browser: take in any page it opened, then show the tab of the page the shell shows.
    useEffect(() => window.veraDesktop?.onEvent((event) => {
        if (event.type !== "command" || event.id !== "browser.reveal") return;
        void (async () => {
            await nativeCommand("state");
            await syncRef.current();
            const held = browserSlots.get();
            const shown = [...held.slots].find(([, slot]) => slot.page !== undefined && slot.page === held.native?.active)?.[0];
            if (shown !== undefined && shown !== CONTAINER_SLOT) latest.current.dispatch({ type: "activateTab", tab: shown });
            else revealContainer(latest.current, BROWSER_CONTAINER);
        })();
    }), []);

    return null;
}
