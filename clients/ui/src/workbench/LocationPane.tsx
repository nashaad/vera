import { HeaderToggle } from "../components/HeaderToggle.tsx";
import { LOCATION_SIZES, LOCATION_TITLES, type LocationId } from "../layout/model.ts";
import { GENERIC_PAGE_KIND } from "../pagepane/kinds.ts";
import { useWorkbench } from "./context.tsx";
import { canDropInLocation, draggedContainer, useDrag, useDropTarget } from "./drag.tsx";
import { SidebarFoot } from "./SidebarFoot.tsx";
import { SidebarNav } from "./SidebarNav.tsx";
import { PaneLauncher } from "./PaneLauncher.tsx";
import { PaneTiles } from "./PaneTiles.tsx";
import { SidebarTop } from "./SidebarTop.tsx";
import { Switcher } from "./Switcher.tsx";
import { PaneTabContext } from "./tab-context.tsx";
import { ViewStack } from "./ViewStack.tsx";

export interface LocationPaneProps {
    readonly location: LocationId;
}

// The pane for one location, with its container switcher: rows under the sidebar's top row,
// tabs above the panel, and in the right pane's top row the pane's own tabs, the "+" and the toggle.
export function LocationPane({ location }: LocationPaneProps) {
    const { layout, dispatch } = useWorkbench();
    const resolved = layout.locations[location];
    const active = resolved.active;
    const { payload } = useDrag();
    // One container needs no switcher: its view draws its own headings. The rows come back
    // with a second container, and during a drag so a container can still be dropped there.
    const sidebarSwitcher = resolved.containers.length !== 1 || payload !== undefined;
    // The right pane draws its tiles while it has no tab.
    const tiles = location === "rightPane" && resolved.tabs.length === 0;

    // A view dropped on the body joins the active container, or makes a container of its own in the
    // empty right pane; a container dropped there moves here.
    const drop = useDropTarget({
        id: `body.${location}`,
        accepts: (dragged) => canDropInLocation(dragged, location)
            && (dragged.kind !== "view" || ((active !== undefined && active.id !== GENERIC_PAGE_KIND) || tiles)),
        onDrop: (dragged) => {
            if (dragged.kind === "view" && active !== undefined) {
                dispatch({ type: "moveView", view: dragged.id, to: { container: active.id } });
            } else if (dragged.kind === "view") {
                dispatch({ type: "moveView", view: dragged.id, to: { location } });
            } else {
                const container = draggedContainer(dragged);
                if (container !== undefined) dispatch({ type: "moveContainer", container, location });
            }
        },
    });

    const body = (
        <div
            className="location-body"
            data-drop={drop.over ? "over" : drop.active ? "available" : undefined}
            onDragOver={drop.props.onDragOver}
            onDragLeave={drop.props.onDragLeave}
            onDrop={drop.props.onDrop}
        >
            {location === "rightPane"
                ? resolved.tabs.map((tab) => (
                    <PaneTabContext.Provider key={tab.id} value={tab.id}>
                        <ViewStack container={tab.container} tab={tab.id} active={tab.id === resolved.activeTab?.id} />
                    </PaneTabContext.Provider>
                ))
                : resolved.containers.map((container) => (
                    <ViewStack key={container.id} container={container} active={container.id === active?.id} />
                ))}
            {tiles ? <PaneTiles /> : null}
        </div>
    );

    // The size is the height of the panel. A side pane's width is its basis and gives way, down
    // to its minimum, when the window is too narrow for the main area's minimum.
    const size = location === "panel"
        ? { height: resolved.size }
        : { flex: `0 1 ${resolved.size}px`, minWidth: LOCATION_SIZES[location].min };
    return (
        <section
            className="location"
            data-location={location}
            aria-label={LOCATION_TITLES[location]}
            style={size}
        >
            {location === "sidebar" ? (
                <>
                    <SidebarTop />
                    <SidebarNav />
                    {sidebarSwitcher ? <Switcher location="sidebar" variant="nav" /> : null}
                </>
            ) : null}
            {location === "panel" ? <Switcher location="panel" variant="tabs" /> : null}
            {location === "rightPane" ? (
                <div className="pane-top">
                    <Switcher location="rightPane" variant="pills" />
                    <PaneLauncher />
                    <span className="spacer" />
                    <HeaderToggle location="rightPane" />
                </div>
            ) : null}
            {body}
            {location === "sidebar" ? <SidebarFoot /> : null}
        </section>
    );
}
