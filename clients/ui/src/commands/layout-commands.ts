import { isLocationId, type LocationId } from "../layout/model.ts";
import type { LayoutAction } from "../layout/reducer.ts";
import type { CommandRegistry } from "./registry.ts";

export const LAYOUT_COMMANDS = {
    toggleSidebar: "layout.toggleSidebar",
    toggleRightPane: "layout.toggleRightPane",
    togglePanel: "layout.togglePanel",
    reset: "layout.reset",
    viewMoveTo: "view.moveTo",
    viewHide: "view.hide",
    viewShow: "view.show",
    viewCollapse: "view.collapse",
    viewExpand: "view.expand",
    viewReset: "view.reset",
    containerMoveTo: "container.moveTo",
    containerHide: "container.hide",
    containerShow: "container.show",
    containerActivate: "container.activate",
    containerReset: "container.reset",
} as const;

function field(args: unknown, name: string): unknown {
    return typeof args === "object" && args !== null ? (args as Record<string, unknown>)[name] : undefined;
}

function textArg(args: unknown, name: string): string {
    const value = field(args, name);
    if (typeof value !== "string" || value.length === 0) throw new Error(`Missing argument ${name}.`);
    return value;
}

function indexArg(args: unknown): number | undefined {
    const value = field(args, "index");
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function locationArg(args: unknown): LocationId {
    const value = field(args, "location");
    if (!isLocationId(value)) throw new Error("Missing argument location.");
    return value;
}

export function registerLayoutCommands(
    registry: CommandRegistry,
    dispatch: (action: LayoutAction) => void,
): () => void {
    const toggles: ReadonlyArray<readonly [string, string, LocationId]> = [
        [LAYOUT_COMMANDS.toggleSidebar, "Toggle Sidebar", "sidebar"],
        [LAYOUT_COMMANDS.toggleRightPane, "Toggle Right Pane", "rightPane"],
        [LAYOUT_COMMANDS.togglePanel, "Toggle Panel", "panel"],
    ];
    const disposers = [
        ...toggles.map(([id, title, location]) => registry.register({
            id,
            title,
            run: () => dispatch({ type: "toggleLocation", location }),
        })),
        registry.register({
            id: LAYOUT_COMMANDS.reset,
            title: "Reset Layout",
            run: () => dispatch({ type: "resetLayout" }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.viewMoveTo,
            title: "Move View",
            run: (args) => {
                const view = textArg(args, "view");
                const index = indexArg(args);
                const container = field(args, "container");
                if (typeof container === "string") {
                    dispatch({ type: "moveView", view, to: { container, ...(index === undefined ? {} : { index }) } });
                } else {
                    dispatch({ type: "moveView", view, to: { location: locationArg(args), ...(index === undefined ? {} : { index }) } });
                }
            },
        }),
        registry.register({
            id: LAYOUT_COMMANDS.viewHide,
            title: "Hide View",
            run: (args) => dispatch({ type: "setViewHidden", view: textArg(args, "view"), hidden: true }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.viewShow,
            title: "Show View",
            run: (args) => dispatch({ type: "setViewHidden", view: textArg(args, "view"), hidden: false }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.viewCollapse,
            title: "Collapse View",
            run: (args) => dispatch({ type: "setViewCollapsed", view: textArg(args, "view"), collapsed: true }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.viewExpand,
            title: "Expand View",
            run: (args) => dispatch({ type: "setViewCollapsed", view: textArg(args, "view"), collapsed: false }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.viewReset,
            title: "Reset View Location",
            run: (args) => dispatch({ type: "resetView", view: textArg(args, "view") }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.containerMoveTo,
            title: "Move View Container",
            run: (args) => {
                const index = indexArg(args);
                dispatch({
                    type: "moveContainer",
                    container: textArg(args, "container"),
                    location: locationArg(args),
                    ...(index === undefined ? {} : { index }),
                });
            },
        }),
        registry.register({
            id: LAYOUT_COMMANDS.containerHide,
            title: "Hide View Container",
            run: (args) => dispatch({ type: "setContainerHidden", container: textArg(args, "container"), hidden: true }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.containerShow,
            title: "Show View Container",
            run: (args) => dispatch({ type: "setContainerHidden", container: textArg(args, "container"), hidden: false }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.containerActivate,
            title: "Activate View Container",
            run: (args) => dispatch({ type: "activateContainer", container: textArg(args, "container") }),
        }),
        registry.register({
            id: LAYOUT_COMMANDS.containerReset,
            title: "Reset View Container Location",
            run: (args) => dispatch({ type: "resetContainer", container: textArg(args, "container") }),
        }),
    ];
    return () => disposers.forEach((dispose) => dispose());
}
