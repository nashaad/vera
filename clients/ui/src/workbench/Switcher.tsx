import { useRef, useState, type MouseEvent } from "react";

import { containerMenu, switcherMenu } from "../commands/menus.ts";
import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import type { LocationId } from "../layout/model.ts";
import { ContainerIcon } from "./ContainerIcon.tsx";
import { dropIndex, useDrag, useDropTarget } from "./drag.tsx";
import { useWorkbench } from "./context.tsx";

export interface SwitcherProps {
    readonly location: LocationId;
    // "nav" is the rows at the top of the sidebar, "pills" the right pane's top row,
    // "tabs" the strip above the panel.
    readonly variant: "nav" | "pills" | "tabs";
}

interface Marker {
    readonly id: string;
    readonly side: "before" | "after";
}

export function Switcher({ location, variant }: SwitcherProps) {
    const { layout, dispatch, run, openMenu } = useWorkbench();
    const { start, payload } = useDrag();
    const ref = useRef<HTMLDivElement>(null);
    const [marker, setMarker] = useState<Marker | undefined>(undefined);
    const resolved = layout.locations[location];
    const horizontal = variant !== "nav";

    // The tabs still in place, in order, leaving out the one being dragged.
    const remaining = (): HTMLElement[] =>
        [...(ref.current?.querySelectorAll<HTMLElement>("[data-container]") ?? [])]
            .filter((element) => !(payload?.kind === "container" && element.dataset.container === payload.id));

    const indexAt = (event: { clientX: number; clientY: number }): number => dropIndex(
        remaining().map((element) => {
            const box = element.getBoundingClientRect();
            return horizontal
                ? { start: box.left, size: box.width }
                : { start: box.top, size: box.height };
        }),
        horizontal ? event.clientX : event.clientY,
    );

    const drop = useDropTarget({
        id: `switcher.${location}`,
        accepts: () => true,
        onOver: (event) => {
            const items = remaining();
            const index = indexAt(event);
            const before = items[index];
            const last = items[items.length - 1];
            setMarker(
                before !== undefined
                    ? { id: before.dataset.container as string, side: "before" }
                    : last !== undefined
                        ? { id: last.dataset.container as string, side: "after" }
                        : undefined,
            );
        },
        onDrop: (dragged, event) => {
            setMarker(undefined);
            const index = indexAt(event);
            if (dragged.kind === "container") {
                dispatch({ type: "moveContainer", container: dragged.id, location, index });
            } else {
                dispatch({ type: "moveView", view: dragged.id, to: { location, index } });
            }
        },
    });

    const onContextMenu = (event: MouseEvent): void => {
        event.preventDefault();
        const entries = switcherMenu(layout, location);
        if (entries.length > 0) openMenu(entries, { x: event.clientX, y: event.clientY });
    };

    const items = resolved.containers.map((container) => {
        const active = resolved.visible && resolved.active?.id === container.id;
        return (
            <button
                key={container.id}
                type="button"
                className="switcher-item"
                role="tab"
                aria-selected={active}
                aria-label={container.title}
                title={container.title}
                draggable
                data-container={container.id}
                data-active={active}
                data-marker={marker?.id === container.id ? marker.side : undefined}
                onClick={() => run(LAYOUT_COMMANDS.containerActivate, { container: container.id })}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(containerMenu(layout, container.id), { x: event.clientX, y: event.clientY });
                }}
                onDragStart={(event) => start({ kind: "container", id: container.id }, event)}
            >
                <ContainerIcon name={container.icon} />
                <span className="switcher-title">{container.title}</span>
            </button>
        );
    });

    const label = `${location} containers`;
    const orientation = horizontal ? "horizontal" : "vertical";
    return (
        <div
            ref={ref}
            className="switcher"
            data-variant={variant}
            data-switcher={location}
            data-drop={drop.over ? "over" : drop.active ? "available" : undefined}
            role="tablist"
            aria-orientation={orientation}
            aria-label={label}
            onContextMenu={onContextMenu}
            onDragLeave={(event) => {
                drop.props.onDragLeave?.(event);
                if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
                    setMarker(undefined);
                }
            }}
            onDragOver={drop.props.onDragOver}
            onDrop={drop.props.onDrop}
        >
            {items}
        </div>
    );
}
