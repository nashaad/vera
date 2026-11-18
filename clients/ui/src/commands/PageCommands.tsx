import { useEffect, useRef } from "react";

import { requestHistory } from "../browser/history-request.ts";
import { BROWSER_CONTAINER } from "../browser/open.ts";
import { usePageLinks } from "../pagepane/PageLinks.tsx";
import { openAnnexPath } from "../pagepane/open.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { revealContainer } from "../workbench/reveal.ts";
import { BROWSER_HISTORY_COMMAND } from "./keys.ts";
import { canOpenBrowser, openBrowser, registerOpenBrowser } from "./open-browser.ts";
import { registerPageCommands } from "./page-commands.ts";
import { showPagePicker } from "./page-picker.ts";
import type { CommandRegistry } from "./registry.ts";

// Registers the available annex pages in the Pages command group.
export function PageCommands({ commands }: { readonly commands: CommandRegistry }) {
    const workbench = useWorkbench();
    const { annex } = usePageLinks();
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
                const current = latest.current;
                if (current.hidden.has(BROWSER_HISTORY_COMMAND)) return;
                if (!current.layout.containers.some((container) => container.id === BROWSER_CONTAINER)) return;
                revealContainer(current, BROWSER_CONTAINER);
                requestHistory();
            },
        });
    }, [commands]);

    useEffect(() => registerPageCommands(commands, {
        open: (page, path) => openAnnexPath(latest.current, page, path),
        list: (pages) => showPagePicker(pages, (page) => openAnnexPath(latest.current, page, page.path)),
    }, annex?.pages ?? []), [annex, commands]);
    return null;
}
