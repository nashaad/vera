import { useSyncExternalStore } from "react";

export type PaneLayout = "single" | "split" | "stack";

export interface Companion {
    readonly parentId: string;
    readonly agentId: string;
}

export interface PaneState {
    readonly layout: PaneLayout;
    // The subagent chosen for the second pane; without one the pane shows the newest child.
    readonly companion?: Companion;
}

const ORDER: readonly PaneLayout[] = ["single", "split", "stack"];

let state: PaneState = { layout: "single" };
const listeners = new Set<() => void>();

function update(next: PaneState): void {
    state = next;
    for (const listener of listeners) listener();
}

export function setPaneLayout(layout: PaneLayout): void {
    if (layout === state.layout) return;
    update({ ...state, layout });
}

export function cyclePaneLayout(): void {
    const next = ORDER[(ORDER.indexOf(state.layout) + 1) % ORDER.length] ?? "single";
    setPaneLayout(next);
}

export function openCompanion(parentId: string, agentId: string): void {
    update({ layout: state.layout === "single" ? "split" : state.layout, companion: { parentId, agentId } });
}

export function closeCompanion(): void {
    update({ layout: "single" });
}

export function paneState(): PaneState {
    return state;
}

export function subscribePaneLayout(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function usePaneLayout(): PaneState {
    return useSyncExternalStore(subscribePaneLayout, paneState);
}
