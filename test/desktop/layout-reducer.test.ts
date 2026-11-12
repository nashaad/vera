import { expect, test } from "bun:test";

import {
    clampSize,
    defaultLayout,
    LOCATION_SIZES,
    type LayoutState,
    type LocationId,
    type RegistrySnapshot,
} from "../../clients/ui/src/layout/model.ts";
import { reduceLayout, type LayoutAction } from "../../clients/ui/src/layout/reducer.ts";
import { resolveLayout, type ResolvedLayout } from "../../clients/ui/src/layout/resolve.ts";

const REGISTRY: RegistrySnapshot = {
    containers: [
        { id: "c.sessions", title: "Sessions", icon: "sessions", location: "sidebar" },
        { id: "c.vera", title: "Vera", icon: "vera", location: "rightPane" },
        { id: "c.output", title: "Output", icon: "output", location: "panel" },
    ],
    views: [
        { id: "v.sessions", title: "Sessions", container: "c.sessions" },
        { id: "v.host", title: "Host", container: "c.vera" },
        { id: "v.notes", title: "Notes", container: "c.vera" },
        { id: "v.output", title: "Output", container: "c.output" },
    ],
};

function apply(state: LayoutState, ...actions: LayoutAction[]): LayoutState {
    return actions.reduce((next, action) => reduceLayout(next, action, REGISTRY), state);
}

function ids(layout: ResolvedLayout, location: LocationId): string[] {
    return layout.locations[location].containers.map((container) => container.id);
}

function viewIds(layout: ResolvedLayout, container: string): string[] {
    return layout.containers.find((candidate) => candidate.id === container)!.views.map((view) => view.id);
}

function containerOf(layout: ResolvedLayout, view: string): string | undefined {
    return layout.containers.find((container) => container.views.some((v) => v.id === view))?.id;
}

test("@core the default layout places every view where its contribution says", () => {
    const layout = resolveLayout(defaultLayout(), REGISTRY);
    expect(ids(layout, "sidebar")).toEqual(["c.sessions"]);
    expect(ids(layout, "rightPane")).toEqual(["c.vera"]);
    expect(ids(layout, "panel")).toEqual(["c.output"]);
    expect(viewIds(layout, "c.vera")).toEqual(["v.host", "v.notes"]);
    expect(layout.locations.sidebar.visible).toBe(true);
    expect(layout.locations.panel.visible).toBe(false);
    expect(layout.locations.sidebar.active?.id).toBe("c.sessions");
});

test("@core the right pane starts closed and a toggle opens it, keeping its container listed", () => {
    const closed = resolveLayout(defaultLayout(), REGISTRY);
    expect(closed.locations.rightPane.visible).toBe(false);
    expect(ids(closed, "rightPane")).toEqual(["c.vera"]);
    const open = apply(defaultLayout(), { type: "toggleLocation", location: "rightPane" });
    expect(resolveLayout(open, REGISTRY).locations.rightPane.visible).toBe(true);
    expect(apply(open, { type: "resetLayout" }).locations.rightPane.visible).toBe(false);
});

test("the layout resolves identically from a copy of itself", () => {
    const state = apply(defaultLayout(), { type: "moveView", view: "v.host", to: { location: "panel" } });
    expect(resolveLayout(structuredClone(state), REGISTRY)).toEqual(resolveLayout(state, REGISTRY));
});

test("toggling and resizing a location change only that location", () => {
    const hidden = apply(defaultLayout(), { type: "toggleLocation", location: "sidebar" });
    expect(hidden.locations.sidebar.visible).toBe(false);
    expect(hidden.locations.rightPane).toEqual(defaultLayout().locations.rightPane);
    expect(apply(hidden, { type: "toggleLocation", location: "sidebar" }).locations.sidebar.visible).toBe(true);
    const resized = apply(defaultLayout(), { type: "resizeLocation", location: "panel", size: 9999 });
    expect(resized.locations.panel.size).toBe(LOCATION_SIZES.panel.max);
    expect(clampSize("sidebar", 1)).toBe(LOCATION_SIZES.sidebar.min);
});

test("an action that changes nothing returns the same state", () => {
    const state = defaultLayout();
    expect(apply(state, { type: "setLocationVisible", location: "sidebar", visible: true })).toBe(state);
    expect(apply(state, { type: "resizeLocation", location: "sidebar", size: LOCATION_SIZES.sidebar.initial })).toBe(state);
    expect(apply(state, { type: "setViewHidden", view: "v.host", hidden: false })).toBe(state);
    expect(apply(state, { type: "moveView", view: "missing", to: { location: "panel" } })).toBe(state);
});

test("@core a view dragged into another container joins it at the given index", () => {
    const state = apply(defaultLayout(), { type: "moveView", view: "v.sessions", to: { container: "c.vera", index: 1 } });
    const layout = resolveLayout(state, REGISTRY);
    expect(viewIds(layout, "c.vera")).toEqual(["v.host", "v.sessions", "v.notes"]);
    expect(ids(layout, "sidebar")).toEqual([]);
    expect(state.viewContainer["v.sessions"]).toBe("c.vera");
});

test("moving a view within its container reorders it", () => {
    const state = apply(defaultLayout(), { type: "moveView", view: "v.host", to: { container: "c.vera" } });
    expect(viewIds(resolveLayout(state, REGISTRY), "c.vera")).toEqual(["v.notes", "v.host"]);
});

test("@core a view moved out on its own makes a new container at that location", () => {
    const state = apply(defaultLayout(), { type: "moveView", view: "v.sessions", to: { location: "panel", index: 0 } });
    const layout = resolveLayout(state, REGISTRY);
    const panel = layout.locations.panel;
    expect(panel.containers).toHaveLength(2);
    expect(panel.containers[0]!.views.map((view) => view.id)).toEqual(["v.sessions"]);
    expect(panel.containers[0]!.generated).toBe(true);
    expect(panel.containers[0]!.title).toBe("Sessions");
    expect(panel.containers[1]!.id).toBe("c.output");
    expect(panel.visible).toBe(true);
    expect(panel.active?.id).toBe(panel.containers[0]!.id);
});

test("a generated container is removed once its last view leaves", () => {
    const moved = apply(defaultLayout(), { type: "moveView", view: "v.sessions", to: { location: "panel" } });
    const back = apply(moved, { type: "moveView", view: "v.sessions", to: { container: "c.sessions" } });
    expect(back.generated).toEqual({});
    expect(back.viewContainer).toEqual({});
    expect(back.containerLocation).toEqual({});
    expect(ids(resolveLayout(back, REGISTRY), "panel")).toEqual(["c.output"]);
});

test("two views moved out one after the other get separate containers", () => {
    const state = apply(
        defaultLayout(),
        { type: "moveView", view: "v.host", to: { location: "panel" } },
        { type: "moveView", view: "v.notes", to: { location: "panel" } },
    );
    expect(Object.keys(state.generated)).toHaveLength(2);
    expect(resolveLayout(state, REGISTRY).locations.panel.containers).toHaveLength(3);
});

test("@core a container dragged to another location keeps its views", () => {
    const state = apply(defaultLayout(), { type: "moveContainer", container: "c.sessions", location: "panel", index: 0 });
    const layout = resolveLayout(state, REGISTRY);
    expect(ids(layout, "panel")).toEqual(["c.sessions", "c.output"]);
    expect(ids(layout, "sidebar")).toEqual([]);
    expect(viewIds(layout, "c.sessions")).toEqual(["v.sessions"]);
    expect(layout.locations.panel.visible).toBe(true);
});

test("a container moved back to its default location drops the override", () => {
    const state = apply(
        defaultLayout(),
        { type: "moveContainer", container: "c.sessions", location: "panel" },
        { type: "moveContainer", container: "c.sessions", location: "sidebar" },
    );
    expect(state.containerLocation).toEqual({});
});

test("hiding and showing a view and a container", () => {
    const hiddenView = apply(defaultLayout(), { type: "setViewHidden", view: "v.host", hidden: true });
    const stack = resolveLayout(hiddenView, REGISTRY).containers.find((c) => c.id === "c.vera")!;
    expect(stack.views.map((view) => [view.id, view.hidden])).toEqual([["v.host", true], ["v.notes", false]]);
    expect(stack.shown).toBe(true);

    const bothHidden = apply(hiddenView, { type: "setViewHidden", view: "v.notes", hidden: true });
    expect(ids(resolveLayout(bothHidden, REGISTRY), "rightPane")).toEqual([]);
    const reshown = apply(bothHidden, { type: "setContainerHidden", container: "c.vera", hidden: false });
    expect(ids(resolveLayout(reshown, REGISTRY), "rightPane")).toEqual(["c.vera"]);
    expect(reshown.hiddenViews).toEqual([]);

    const hiddenContainer = apply(defaultLayout(), { type: "setContainerHidden", container: "c.sessions", hidden: true });
    expect(ids(resolveLayout(hiddenContainer, REGISTRY), "sidebar")).toEqual([]);
    const shown = apply(hiddenContainer, { type: "setContainerHidden", container: "c.sessions", hidden: false });
    expect(ids(resolveLayout(shown, REGISTRY), "sidebar")).toEqual(["c.sessions"]);
});

test("showing a container in a collapsed location reveals the location", () => {
    const state = apply(
        defaultLayout(),
        { type: "setContainerHidden", container: "c.output", hidden: true },
        { type: "setContainerHidden", container: "c.output", hidden: false },
    );
    expect(state.locations.panel.visible).toBe(true);
    expect(state.locations.panel.active).toBe("c.output");
});

test("collapsing a view is saved per view", () => {
    const state = apply(defaultLayout(), { type: "setViewCollapsed", view: "v.notes", collapsed: true });
    const views = resolveLayout(state, REGISTRY).containers.find((c) => c.id === "c.vera")!.views;
    expect(views.map((view) => view.collapsed)).toEqual([false, true]);
    expect(apply(state, { type: "setViewCollapsed", view: "v.notes", collapsed: false }).collapsedViews).toEqual([]);
});

test("@core resetting a view returns it to its default container", () => {
    const moved = apply(defaultLayout(), { type: "moveView", view: "v.sessions", to: { container: "c.output" } });
    const reset = apply(moved, { type: "resetView", view: "v.sessions" });
    const layout = resolveLayout(reset, REGISTRY);
    expect(containerOf(layout, "v.sessions")).toBe("c.sessions");
    expect(layout.locations.sidebar.visible).toBe(true);
    expect(reset.viewContainer).toEqual({});
});

test("resetting a view that left for a new container removes that container", () => {
    const moved = apply(defaultLayout(), { type: "moveView", view: "v.sessions", to: { location: "rightPane" } });
    const reset = apply(moved, { type: "resetView", view: "v.sessions" });
    expect(reset.generated).toEqual({});
    expect(containerOf(resolveLayout(reset, REGISTRY), "v.sessions")).toBe("c.sessions");
});

test("@core resetting a container returns it to its default location and order", () => {
    const moved = apply(defaultLayout(), { type: "moveContainer", container: "c.sessions", location: "panel", index: 0 });
    const reset = apply(moved, { type: "resetContainer", container: "c.sessions" });
    const layout = resolveLayout(reset, REGISTRY);
    expect(ids(layout, "sidebar")).toEqual(["c.sessions"]);
    expect(ids(layout, "panel")).toEqual(["c.output"]);
    expect(reset.containerLocation).toEqual({});
});

test("resetting a generated container sends its views home", () => {
    const moved = apply(defaultLayout(), { type: "moveView", view: "v.host", to: { location: "panel" } });
    const generated = Object.keys(moved.generated)[0]!;
    const reset = apply(moved, { type: "resetContainer", container: generated });
    expect(containerOf(resolveLayout(reset, REGISTRY), "v.host")).toBe("c.vera");
    expect(reset.generated).toEqual({});
});

test("resetting the layout restores every default, sizes included", () => {
    const changed = apply(
        defaultLayout(),
        { type: "moveView", view: "v.host", to: { location: "panel" } },
        { type: "resizeLocation", location: "sidebar", size: 300 },
        { type: "toggleLocation", location: "rightPane" },
    );
    expect(apply(changed, { type: "resetLayout" })).toEqual(defaultLayout());
});

test("@core a saved layout naming an unregistered view or container is ignored and the rest holds", () => {
    const state: LayoutState = {
        ...defaultLayout(),
        viewContainer: { "ext.view": "ext.container", "v.notes": "c.sessions" },
        viewOrder: { "c.sessions": ["ext.view", "v.notes", "v.sessions"] },
        containerOrder: { sidebar: ["ext.container", "c.sessions"], rightPane: [], panel: [] },
        containerLocation: { "ext.container": "panel" },
        hiddenViews: ["ext.view"],
    };
    const layout = resolveLayout(state, REGISTRY);
    expect(ids(layout, "sidebar")).toEqual(["c.sessions"]);
    expect(viewIds(layout, "c.sessions")).toEqual(["v.notes", "v.sessions"]);
    expect(ids(layout, "panel")).toEqual(["c.output"]);
});

test("a saved view whose saved container is gone falls back to its default container", () => {
    const state: LayoutState = { ...defaultLayout(), viewContainer: { "v.host": "ext.gone" } };
    expect(containerOf(resolveLayout(state, REGISTRY), "v.host")).toBe("c.vera");
});

test("@core a re-registered view returns to where the person last put it", () => {
    const withExtension: RegistrySnapshot = {
        containers: [...REGISTRY.containers, { id: "ext.box", title: "Box", icon: "view", location: "sidebar" }],
        views: [...REGISTRY.views, { id: "ext.view", title: "Ext", container: "ext.box" }],
    };
    let state = reduceLayout(defaultLayout(), { type: "moveView", view: "ext.view", to: { container: "c.output" } }, withExtension);
    state = reduceLayout(state, { type: "moveContainer", container: "ext.box", location: "rightPane" }, withExtension);
    expect(containerOf(resolveLayout(state, withExtension), "ext.view")).toBe("c.output");

    // The extension goes away: the rest of the layout holds and nothing is rewritten.
    const gone = resolveLayout(state, REGISTRY);
    expect(ids(gone, "panel")).toEqual(["c.output"]);
    expect(viewIds(gone, "c.output")).toEqual(["v.output"]);
    const afterOtherChange = reduceLayout(state, { type: "toggleLocation", location: "sidebar" }, REGISTRY);
    expect(afterOtherChange.viewContainer["ext.view"]).toBe("c.output");
    expect(afterOtherChange.containerLocation["ext.box"]).toBe("rightPane");

    // It comes back where it was left.
    const back = resolveLayout(afterOtherChange, withExtension);
    expect(containerOf(back, "ext.view")).toBe("c.output");
    expect(back.locations.rightPane.all.map((container) => container.id)).toContain("ext.box");
});

test("a generated container holding an unregistered view survives other moves", () => {
    const withExtension: RegistrySnapshot = {
        containers: REGISTRY.containers,
        views: [...REGISTRY.views, { id: "ext.view", title: "Ext", container: "c.vera" }],
    };
    let state = reduceLayout(defaultLayout(), { type: "moveView", view: "ext.view", to: { location: "panel" } }, withExtension);
    const generated = Object.keys(state.generated);
    state = reduceLayout(state, { type: "moveView", view: "v.host", to: { location: "panel" } }, REGISTRY);
    expect(Object.keys(state.generated)).toEqual(expect.arrayContaining(generated));
    expect(containerOf(resolveLayout(state, withExtension), "ext.view")).toBe(generated[0]);
});
