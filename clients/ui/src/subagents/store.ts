import { useSyncExternalStore } from "react";

// Which session's subagents the Subagents tab was last pointed at, and the child open in its detail.
// The tab holds one view at a time, so this is one value, not one per tab.
export interface SubagentsFocus {
    readonly parentId: string;
    readonly childId?: string;
}

let focus: SubagentsFocus | undefined;
const listeners = new Set<() => void>();

function set(next: SubagentsFocus | undefined): void {
    focus = next;
    for (const listener of listeners) listener();
}

export const subagentsTab = {
    subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    snapshot: (): SubagentsFocus | undefined => focus,
    // A child opens its detail; no child shows the list.
    show: (parentId: string, childId?: string): void => {
        set({ parentId, ...(childId === undefined ? {} : { childId }) });
    },
    reset: (): void => {
        if (focus !== undefined) set(undefined);
    },
};

// The child the tab shows in detail for the open session, or undefined for its list.
export function openChild(state: SubagentsFocus | undefined, activeAgentId: string): string | undefined {
    return state?.parentId === activeAgentId ? state.childId : undefined;
}

export function useSubagentsFocus(): SubagentsFocus | undefined {
    return useSyncExternalStore(subagentsTab.subscribe, subagentsTab.snapshot);
}
