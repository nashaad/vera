import { useEffect } from "react";

import { useIsShown, useWorkbench } from "../workbench/context.tsx";
import { closeChatTab } from "./open.ts";
import { chatTabs } from "./store.ts";

// Drops what a Chat tab showed once the tab is closed, so its watch pane can serve the next one.
// Hiding the right pane ends every watch in it and the host drops an ephemeral sidekick with its last watch,
// so the tabs of sidekicks close with it.
export function ChatSync() {
    const workbench = useWorkbench();
    const shown = useIsShown("rightPane");
    const open = workbench.layout.locations.rightPane.tabs;
    useEffect(() => {
        const ids = new Set(open.map((tab) => tab.id));
        const gone = [...chatTabs.snapshot()].filter(([tab, entry]) => !ids.has(tab) || (!shown && entry.kind === "sidekick"));
        for (const [tab] of gone) if (ids.has(tab)) closeChatTab(workbench, tab);
        chatTabs.drop(gone.map(([tab]) => tab));
    }, [open, shown, workbench]);
    return null;
}
