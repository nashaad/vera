import { HeaderToggle } from "../components/HeaderToggle.tsx";
import { LOCATION_SIZES, LOCATION_TITLES, type LocationId } from "../layout/model.ts";
import { useWorkbench } from "./context.tsx";
import { useDrag, useDropTarget } from "./drag.tsx";
import { SidebarFoot } from "./SidebarFoot.tsx";
import { SidebarNav } from "./SidebarNav.tsx";
import { SidebarTop } from "./SidebarTop.tsx";
import { Switcher } from "./Switcher.tsx";
import { ViewStack } from "./ViewStack.tsx";

export interface LocationPaneProps {
    readonly location: LocationId;
}

// The pane for one location, with its container switcher: rows under the sidebar's top row,
// tabs above the panel, pills in the right pane's top row.
export function LocationPane({ location }: LocationPaneProps) {
    const { layout, dispatch } = useWorkbench();
    const resolved = layout.locations[location];
    const active = resolved.active;
    const { payload } = useDrag();
    // One container needs no switcher: its view draws its own headings. The rows come back
    // with a second container, and during a drag so a container can still be dropped there.
    const sidebarSwitcher = resolved.containers.length !== 1 || payload !== undefined;

    // A view dropped on the body joins the active container; a container dropped there moves here.
    const drop = useDropTarget({
        id: `body.${location}`,
        accepts: (dragged) => (dragged.kind === "view" ? active !== undefined : true),
        onDrop: (dragged) => {
            if (dragged.kind === "view" && active !== undefined) {
                dispatch({ type: "moveView", view: dragged.id, to: { container: active.id } });
            } else if (dragged.kind === "container") {
                dispatch({ type: "moveContainer", container: dragged.id, location });
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
            {resolved.containers.map((container) => (
                <ViewStack key={container.id} container={container} active={container.id === active?.id} />
            ))}
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
                    <span className="spacer" />
                    <HeaderToggle location="rightPane" />
                </div>
            ) : null}
            {body}
            {location === "sidebar" ? <SidebarFoot /> : null}
        </section>
    );
}
