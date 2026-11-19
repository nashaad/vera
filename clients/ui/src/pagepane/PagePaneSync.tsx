import { useEffect, useRef } from "react";

import { useWorkbench } from "../workbench/context.tsx";
import { tabDots, useMarkedKinds } from "../workbench/tabDots.ts";
import { pageTabs } from "./store.ts";

// Drops what a page tab showed once the tab is closed, and clears a change mark once its tab is shown or gone.
// Only tabs the pane has held count, so an entry written just before its tab opens is never dropped early.
export function PagePaneSync() {
    const pane = useWorkbench().layout.locations.rightPane;
    const open = pane.tabs;
    const seen = useRef(new Set<string>());
    const seenKinds = useRef(new Set<string>());
    useEffect(() => {
        const ids = new Set(open.map((tab) => tab.id));
        for (const id of ids) seen.current.add(id);
        const gone = [...seen.current].filter((id) => !ids.has(id));
        for (const id of gone) seen.current.delete(id);
        pageTabs.drop(gone);

        const kinds = new Set(open.map((tab) => tab.container.id));
        tabDots.clear([...seenKinds.current].filter((kind) => !kinds.has(kind)));
        seenKinds.current = kinds;
    }, [open]);

    const marked = useMarkedKinds();
    const shownKind = pane.visible ? pane.activeTab?.container.id : undefined;
    useEffect(() => {
        if (shownKind !== undefined) tabDots.clear([shownKind]);
    }, [marked, shownKind]);
    return null;
}
