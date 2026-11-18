import { useEffect, useRef } from "react";

import { requestHistory } from "../browser/history-request.ts";
import { BROWSER_CONTAINER, openBrowserTab, showAnnexIn } from "../browser/open.ts";
import { browserSlots, CONTAINER_SLOT } from "../browser/slots.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { revealContainer } from "../workbench/reveal.ts";
import { BROWSER_HISTORY_COMMAND } from "./keys.ts";
import { canOpenBrowser, openBrowser, registerOpenBrowser } from "./open-browser.ts";
import { registerPageCommands } from "./page-commands.ts";
import type { CommandRegistry } from "./registry.ts";

// Registers the commands that open one of Vera's pages in the right pane browser.
export function PageCommands({ commands }: { readonly commands: CommandRegistry }) {
    const workbench = useWorkbench();
    const latest = useRef(workbench);
    latest.current = workbench;

    const browserAvailable = window.veraDesktop !== undefined && canOpenBrowser(workbench.layout);
    useEffect(() => registerOpenBrowser(commands, browserAvailable, () => openBrowser(latest.current)), [commands, browserAvailable]);

    useEffect(() => {
        if (window.veraDesktop === undefined) return;
        return commands.register({
            id: BROWSER_HISTORY_COMMAND,
            title: "Show Browser History",
            run: () => {
                const workbench = latest.current;
                if (workbench.hidden.has(BROWSER_HISTORY_COMMAND)) return;
                if (!workbench.layout.containers.some((container) => container.id === BROWSER_CONTAINER)) return;
                revealContainer(workbench, BROWSER_CONTAINER);
                requestHistory();
            },
        });
    }, [commands]);

    useEffect(() => registerPageCommands(commands, {
        open: (entry) => {
            const { layout, dispatch } = latest.current;
            const placed = layout.containers.find((container) => container.id === BROWSER_CONTAINER);
            if (placed === undefined) return;
            if (placed.hidden) dispatch({ type: "setContainerHidden", container: BROWSER_CONTAINER, hidden: false });
            if (placed.location !== "rightPane") {
                void showAnnexIn(CONTAINER_SLOT, entry);
                dispatch({ type: "setLocationVisible", location: placed.location, visible: true });
                dispatch({ type: "activateContainer", container: BROWSER_CONTAINER });
                return;
            }
            // A tab showing a web page is never replaced; the newest tab showing none takes the page.
            const free = layout.recentTabs.find((id) => {
                const tab = layout.locations.rightPane.tabs.find((candidate) => candidate.id === id);
                return tab?.container.id === BROWSER_CONTAINER && browserSlots.slot(id).page === undefined;
            });
            if (free === undefined) {
                openBrowserTab(dispatch, { entry });
                return;
            }
            browserSlots.browse(free, entry);
            dispatch({ type: "activateTab", tab: free });
        },
    }), [commands]);
    return null;
}
