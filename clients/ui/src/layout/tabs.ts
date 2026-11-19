import type { LayoutState, PaneTab } from "./model.ts";

const TAB_ID = /^tab\.(\d+)$/;

// The next generated tab id, and the sequence number that comes after it.
export function nextTabId(state: LayoutState): { readonly id: string; readonly seq: number } {
    let seq = state.tabSeq + 1;
    while (state.tabs.some((tab) => tab.id === `tab.${seq}`)) seq += 1;
    return { id: `tab.${seq}`, seq };
}

// The highest generated tab number among the ids, so a loaded layout never reuses one.
export function highestTabNumber(tabs: readonly PaneTab[]): number {
    let highest = 0;
    for (const tab of tabs) {
        const match = TAB_ID.exec(tab.id);
        if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
    return highest;
}

// Removes the tabs the predicate names. When the active tab goes, the tab that took its place
// becomes active, else the one before it, else none and the pane shows its tiles.
export function dropTabs(state: LayoutState, doomed: (tab: PaneTab) => boolean): LayoutState {
    const kept = state.tabs.filter((tab) => !doomed(tab));
    if (kept.length === state.tabs.length) return state;
    const rightPane = state.locations.rightPane;
    let active = rightPane.active;
    if (active !== undefined && !kept.some((tab) => tab.id === active)) {
        const at = state.tabs.findIndex((tab) => tab.id === active);
        const after = state.tabs.slice(at + 1).find((tab) => kept.includes(tab));
        const before = state.tabs.slice(0, Math.max(at, 0)).reverse().find((tab) => kept.includes(tab));
        active = (after ?? before)?.id;
    }
    const ids = new Set(kept.map((tab) => tab.id));
    const { active: _gone, ...rest } = rightPane;
    return {
        ...state,
        tabs: kept,
        recentTabs: state.recentTabs.filter((id) => ids.has(id)),
        locations: { ...state.locations, rightPane: active === undefined ? rest : { ...rest, active } },
    };
}
