import { useRef, useState, type MouseEvent } from "react";

import { containerMenu, switcherMenu, tabMenu } from "../commands/menus.ts";
import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { XIcon } from "../components/Icons.tsx";
import type { LocationId } from "../layout/model.ts";
import type { ResolvedContainer, ResolvedTab } from "../layout/resolve.ts";
import { ContainerIcon } from "./ContainerIcon.tsx";
import { draggedContainer, dropIndex, useDrag, useDropTarget } from "./drag.tsx";
import { useWorkbench } from "./context.tsx";
import { useTabTitle } from "./tab-context.tsx";
import { useTabDot } from "./tabDots.ts";

export interface SwitcherProps {
    readonly location: LocationId;
    // "nav" is the rows at the top of the sidebar, "pills" the right pane's tabs (each with a close
    // button), "tabs" the strip above the panel.
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
    const paneTabs = variant === "pills";
    const idOf = (element: HTMLElement): string => (paneTabs ? element.dataset.tab : element.dataset.container) as string;

    // The entries still in place, in order, leaving out the one being dragged.
    const remaining = (): HTMLElement[] =>
        [...(ref.current?.querySelectorAll<HTMLElement>(paneTabs ? "[data-tab]" : "[data-container]") ?? [])]
            .filter((element) => !(
                (payload?.kind === "tab" && paneTabs && idOf(element) === payload.id)
                || (payload?.kind === "container" && !paneTabs && idOf(element) === payload.id)
            ));

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
                    ? { id: idOf(before), side: "before" }
                    : last !== undefined
                        ? { id: idOf(last), side: "after" }
                        : undefined,
            );
        },
        onDrop: (dragged, event) => {
            setMarker(undefined);
            const index = indexAt(event);
            if (dragged.kind === "tab" && paneTabs) {
                dispatch({ type: "moveTab", tab: dragged.id, index });
                return;
            }
            const container = draggedContainer(dragged);
            if (container !== undefined) {
                dispatch({ type: "moveContainer", container, location, ...(paneTabs ? {} : { index }) });
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

    const items = paneTabs
        ? resolved.tabs.map((tab) => (
            <PaneTabItem
                key={tab.id}
                tab={tab}
                active={resolved.visible && resolved.activeTab?.id === tab.id}
                marker={marker?.id === tab.id ? marker.side : undefined}
            />
        ))
        : resolved.containers.map((container) => (
            <ContainerItem
                key={container.id}
                container={container}
                active={resolved.visible && resolved.active?.id === container.id}
                marker={marker?.id === container.id ? marker.side : undefined}
            />
        ));

    const label = paneTabs ? "Pane tabs" : `${location} containers`;
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

interface ItemProps {
    readonly active: boolean;
    readonly marker: Marker["side"] | undefined;
}

function ContainerItem({ container, active, marker: side }: ItemProps & { readonly container: ResolvedContainer }) {
    const { layout, run, openMenu } = useWorkbench();
    const { start } = useDrag();
    return (
        <button
            type="button"
            className="switcher-item"
            role="tab"
            aria-selected={active}
            aria-label={container.title}
            title={container.title}
            draggable
            data-container={container.id}
            data-active={active}
            data-marker={side}
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
}

function PaneTabItem({ tab, active, marker: side }: ItemProps & { readonly tab: ResolvedTab }) {
    const { layout, run, openMenu } = useWorkbench();
    const { start } = useDrag();
    const title = useTabTitle(tab.id) ?? tab.container.title;
    const changed = useTabDot(tab.container.id) && !active;
    // The close button is a sibling of the tab, laid over its right edge, so the tab holds no button.
    return (
        <span className="switcher-pill" role="presentation" data-active={active} data-changed={changed}>
            <button
                type="button"
                className="switcher-item"
                role="tab"
                aria-selected={active}
                aria-label={title}
                title={title}
                draggable
                data-tab={tab.id}
                data-container={tab.container.id}
                data-active={active}
                data-marker={side}
                onClick={() => run(LAYOUT_COMMANDS.tabActivate, { tab: tab.id })}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(tabMenu(layout, tab.id, title), { x: event.clientX, y: event.clientY });
                }}
                onDragStart={(event) => start({ kind: "tab", id: tab.id, container: tab.container.id }, event)}
            >
                <ContainerIcon name={tab.container.icon} />
                <span className="switcher-title">{title}</span>
            </button>
            {changed ? <span className="change-dot" role="img" aria-label="Updated" /> : null}
            <button
                type="button"
                className="icon-button switcher-close"
                aria-label={`Close ${title}`}
                title={`Close ${title}`}
                data-close={tab.id}
                onClick={() => run(LAYOUT_COMMANDS.tabClose, { tab: tab.id })}
            >
                <XIcon />
            </button>
        </span>
    );
}
