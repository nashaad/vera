import { useEffect, useRef } from "react";

import { useActiveSession } from "../session/activeSession.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { SUBAGENTS_CONTAINER } from "./open.ts";
import { subagentsTab } from "./store.ts";

// The Subagents tab starts on its list again once it is closed or another session comes to the page.
export function SubagentsSync() {
    const { layout } = useWorkbench();
    const open = layout.locations.rightPane.tabs.some((tab) => tab.container.id === SUBAGENTS_CONTAINER);
    const wasOpen = useRef(open);
    useEffect(() => {
        if (wasOpen.current && !open) subagentsTab.reset();
        wasOpen.current = open;
    }, [open]);

    const agentId = useActiveSession()?.agentId;
    useEffect(() => {
        const focus = subagentsTab.snapshot();
        if (agentId !== undefined && focus !== undefined && focus.parentId !== agentId) subagentsTab.reset();
    }, [agentId]);
    return null;
}
