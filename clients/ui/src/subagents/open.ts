import type { LayoutAction } from "../layout/reducer.ts";
import { canOpenTab, type ResolvedLayout } from "../layout/resolve.ts";
import { showToast } from "../overlays/toasts.ts";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { subagentsTab } from "./store.ts";

export const SUBAGENTS_CONTAINER = CORE_CONTAINERS.subagents;

export const SUBAGENTS_TAB_FULL = "Close a tab in the right pane to open Subagents.";

// What opening the Subagents tab reads and changes; the workbench provides both.
export interface SubagentsHost {
    readonly layout: ResolvedLayout;
    readonly dispatch: (action: LayoutAction) => void;
}

// Shows the Subagents tab on the child's detail, or on the session's list when no child is given, and opens the
// right pane if it was closed. Always the same tab: the kind holds one. Not for use from a render or an effect.
export function openSubagents(host: SubagentsHost, parentId: string, childId?: string): void {
    const container = host.layout.containers.find((candidate) => candidate.id === SUBAGENTS_CONTAINER);
    if (container === undefined || !container.shown) return;
    const needsTab = container.location === "rightPane" && container.tabCount === 0;
    if (needsTab && !canOpenTab(host.layout, SUBAGENTS_CONTAINER)) {
        showToast(SUBAGENTS_TAB_FULL, "danger");
        return;
    }
    subagentsTab.show(parentId, childId);
    host.dispatch({ type: "activateContainer", container: SUBAGENTS_CONTAINER });
}
