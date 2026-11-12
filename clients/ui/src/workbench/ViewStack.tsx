import { useState, type DragEvent } from "react";

import { viewMenu } from "../commands/menus.ts";
import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { ChevronRightIcon, MoreIcon } from "../components/Icons.tsx";
import type { ResolvedContainer, ResolvedView } from "../layout/resolve.ts";
import { renderView } from "../views/registry.tsx";
import { useWorkbench } from "./context.tsx";
import { useDrag, useDropTarget } from "./drag.tsx";

interface ViewPaneProps {
    readonly container: ResolvedContainer;
    readonly view: ResolvedView;
    readonly active: boolean;
    // The only view of its container: the switcher already names it, so the header keeps
    // only its actions, and a saved collapse is ignored because nothing could expand it.
    readonly merged: boolean;
}

function ViewPane({ container, view, active, merged }: ViewPaneProps) {
    const { layout, dispatch, run, openMenu } = useWorkbench();
    const { start } = useDrag();
    const [edge, setEdge] = useState<"before" | "after" | undefined>(undefined);

    const edgeOf = (event: DragEvent): "before" | "after" => {
        const box = event.currentTarget.getBoundingClientRect();
        return event.clientY > box.top + box.height / 2 ? "after" : "before";
    };

    const drop = useDropTarget({
        id: `view.${view.id}`,
        accepts: (dragged) => dragged.kind === "view" && dragged.id !== view.id,
        onOver: (event) => setEdge(edgeOf(event)),
        onDrop: (dragged, event) => {
            setEdge(undefined);
            const others = container.views.filter((member) => !member.hidden && member.id !== dragged.id);
            const at = others.findIndex((member) => member.id === view.id);
            dispatch({
                type: "moveView",
                view: dragged.id,
                to: { container: container.id, index: edgeOf(event) === "after" ? at + 1 : at },
            });
        },
    });

    const toggle = (): void => run(
        view.collapsed ? LAYOUT_COMMANDS.viewExpand : LAYOUT_COMMANDS.viewCollapse,
        { view: view.id },
    );

    const collapsed = view.collapsed && !merged;
    return (
        <section className="view" data-view={view.id} data-collapsed={collapsed} data-merged={merged}>
            <header
                className="view-header"
                draggable
                data-view-header={view.id}
                data-drop={drop.over ? "over" : drop.active ? "available" : undefined}
                data-marker={drop.over ? edge : undefined}
                onDragStart={(event) => start({ kind: "view", id: view.id }, event)}
                onDragOver={drop.props.onDragOver}
                onDragLeave={(event) => {
                    drop.props.onDragLeave?.(event);
                    setEdge(undefined);
                }}
                onDrop={drop.props.onDrop}
                onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(viewMenu(layout, view.id), { x: event.clientX, y: event.clientY });
                }}
            >
                {merged ? null : (
                    <button
                        type="button"
                        className="view-toggle"
                        aria-expanded={!view.collapsed}
                        onClick={toggle}
                    >
                        <span className="view-title">{view.title}</span>
                        <ChevronRightIcon className="view-chevron" />
                    </button>
                )}
                <button
                    type="button"
                    className="icon-button view-actions"
                    aria-label={`${view.title} actions`}
                    aria-haspopup="menu"
                    onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        openMenu(viewMenu(layout, view.id), { x: box.left, y: box.bottom });
                    }}
                >
                    <MoreIcon />
                </button>
            </header>
            <div className="view-body" hidden={collapsed}>
                {renderView(view.id, { visible: active && !collapsed })}
            </div>
        </section>
    );
}

export interface ViewStackProps {
    readonly container: ResolvedContainer;
    readonly active: boolean;
}

// Every shown container stays mounted; only the active one is displayed.
export function ViewStack({ container, active }: ViewStackProps) {
    const shown = container.views.filter((view) => !view.hidden);
    return (
        <div className="view-stack" data-container-body={container.id} hidden={!active}>
            {shown.map((view) => (
                <ViewPane
                    key={view.id}
                    container={container}
                    view={view}
                    active={active}
                    merged={shown.length === 1}
                />
            ))}
        </div>
    );
}
