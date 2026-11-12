import { LOCATION_TITLES, type LocationId } from "../layout/model.ts";
import { useWorkbench } from "./context.tsx";
import { useDropTarget } from "./drag.tsx";

// Shown only during a drag, for a location that has nothing on screen to drop onto.
export function DropStrip({ location }: { readonly location: LocationId }) {
    const { dispatch } = useWorkbench();
    const drop = useDropTarget({
        id: `strip.${location}`,
        accepts: () => true,
        onDrop: (dragged) => {
            if (dragged.kind === "container") {
                dispatch({ type: "moveContainer", container: dragged.id, location });
            } else {
                dispatch({ type: "moveView", view: dragged.id, to: { location } });
            }
        },
    });
    if (!drop.active) return null;
    return (
        <div
            className="drop-strip"
            data-drop-zone={location}
            data-drop={drop.over ? "over" : "available"}
            onDragOver={drop.props.onDragOver}
            onDragLeave={drop.props.onDragLeave}
            onDrop={drop.props.onDrop}
        >
            {LOCATION_TITLES[location]}
        </div>
    );
}
