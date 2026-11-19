import type { WorkbenchApi } from "./context.tsx";

// Shows a container wherever the person has placed it, turning its location on. In the right
// pane that is its most recently active tab, or a new tab when it has none.
export function revealContainer(workbench: Pick<WorkbenchApi, "layout" | "dispatch">, container: string): void {
    const placed = workbench.layout.containers.find((candidate) => candidate.id === container);
    if (placed === undefined) return;
    if (placed.hidden) workbench.dispatch({ type: "setContainerHidden", container, hidden: false });
    workbench.dispatch({ type: "setLocationVisible", location: placed.location, visible: true });
    workbench.dispatch({ type: "activateContainer", container });
}
