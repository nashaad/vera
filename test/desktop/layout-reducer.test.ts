import { expect, test } from "bun:test";

import {
    clampSize,
    defaultLayout,
    LOCATION_SIZES,
    MAX_TABS,
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

// The right pane holds tabs, each an instance of a container; the sidebar and panel show every container.
const PANES: RegistrySnapshot = {
    containers: [
        { id: "c.sessions", title: "Sessions", icon: "sessions", location: "sidebar" },
        { id: "c.a", title: "A", icon: "view", location: "rightPane" },
        { id: "c.b", title: "B", icon: "view", location: "rightPane" },
        { id: "c.c", title: "C", icon: "view", location: "rightPane", maxTabs: 2 },
        { id: "c.output", title: "Output", icon: "output", location: "panel" },
    ],
    views: [
        { id: "v.sessions", title: "Sessions", container: "c.sessions" },
        { id: "v.a", title: "A", container: "c.a" },
        { id: "v.b", title: "B", container: "c.b" },
        { id: "v.c", title: "C", container: "c.c" },
        { id: "v.output", title: "Output", container: "c.output" },
    ],
};

function onPanes(state: LayoutState, ...actions: LayoutAction[]): LayoutState {
    return actions.reduce((next, action) => reduceLayout(next, action, PANES), state);
}

function strip(state: LayoutState): string[] {
    return resolveLayout(state, PANES).locations.rightPane.tabs.map((tab) => `${tab.id}:${tab.container.id}`);
}

function activeTab(state: LayoutState): string | undefined {
    return resolveLayout(state, PANES).locations.rightPane.activeTab?.id;
}

const activate = (container: string): LayoutAction => ({ type: "activateContainer", container });
const open = (container: string, tab?: string): LayoutAction => ({ type: "openTab", container, ...(tab === undefined ? {} : { tab }) });
const close = (tab: string): LayoutAction => ({ type: "closeTab", tab });

test("@core a new layout lists every right-pane container and has no tab", () => {
    const right = resolveLayout(defaultLayout(), PANES).locations.rightPane;
    expect(right.containers.map((container) => container.id)).toEqual(["c.a", "c.b", "c.c"]);
    expect(right.tabs).toEqual([]);
    expect(right.activeTab).toBeUndefined();
    expect(right.active).toBeUndefined();
    expect(defaultLayout().tabs).toEqual([]);
});

test("@core opening a tab shows the pane, makes the tab active, and always adds a new one", () => {
    const first = onPanes(defaultLayout(), open("c.b"));
    expect(strip(first)).toEqual(["tab.1:c.b"]);
    expect(resolveLayout(first, PANES).locations.rightPane.visible).toBe(true);
    expect(activeTab(first)).toBe("tab.1");
    const twice = onPanes(first, open("c.b"), open("c.a"));
    expect(strip(twice)).toEqual(["tab.1:c.b", "tab.2:c.b", "tab.3:c.a"]);
    expect(activeTab(twice)).toBe("tab.3");
    expect(resolveLayout(twice, PANES).locations.rightPane.active?.id).toBe("c.a");
});

test("@core activating a container shows its most recently active tab, and opens one only when it has none", () => {
    const state = onPanes(defaultLayout(), open("c.a"), open("c.b"), open("c.a"), open("c.b"));
    expect(strip(state)).toEqual(["tab.1:c.a", "tab.2:c.b", "tab.3:c.a", "tab.4:c.b"]);
    const second = onPanes(state, activate("c.a"));
    expect(activeTab(second)).toBe("tab.3");
    expect(strip(second)).toEqual(strip(state));
    const earlier = onPanes(second, { type: "activateTab", tab: "tab.1" }, activate("c.b"), activate("c.a"));
    expect(activeTab(earlier)).toBe("tab.1");
    const none = onPanes(defaultLayout(), activate("c.c"));
    expect(strip(none)).toEqual(["tab.1:c.c"]);
    expect(onPanes(none, activate("c.c"))).toBe(none);
});

test("@core closing the shown tab closes only the active tab of a visible right pane", () => {
    const closeShown: LayoutAction = { type: "closeActiveTab" };
    const two = onPanes(defaultLayout(), open("c.a"), open("c.b"));
    const closed = onPanes(two, closeShown);
    expect(strip(closed)).toEqual(["tab.1:c.a"]);
    expect(activeTab(closed)).toBe("tab.1");
    const empty = onPanes(closed, closeShown);
    expect(strip(empty)).toEqual([]);
    expect(onPanes(empty, closeShown)).toBe(empty);
    const hidden = onPanes(two, { type: "setLocationVisible", location: "rightPane", visible: false });
    expect(onPanes(hidden, closeShown)).toBe(hidden);
});

test("activating a tab switches to it and changes nothing for an unknown or shown tab", () => {
    const state = onPanes(defaultLayout(), open("c.a"), open("c.b"));
    const back = onPanes(state, { type: "activateTab", tab: "tab.1" });
    expect(activeTab(back)).toBe("tab.1");
    expect(onPanes(back, { type: "activateTab", tab: "tab.1" })).toBe(back);
    expect(onPanes(back, { type: "activateTab", tab: "missing" })).toBe(back);
});

test("@core closing the active tab activates the next one, else the previous one, else shows the tiles", () => {
    const three = onPanes(defaultLayout(), open("c.a"), open("c.b"), open("c.a"), { type: "activateTab", tab: "tab.2" });
    const afterMiddle = onPanes(three, close("tab.2"));
    expect(strip(afterMiddle)).toEqual(["tab.1:c.a", "tab.3:c.a"]);
    expect(activeTab(afterMiddle)).toBe("tab.3");
    const afterLast = onPanes(afterMiddle, close("tab.3"));
    expect(activeTab(afterLast)).toBe("tab.1");
    const empty = onPanes(afterLast, close("tab.1"));
    const right = resolveLayout(empty, PANES).locations.rightPane;
    expect(right.visible).toBe(true);
    expect(right.tabs).toEqual([]);
    expect(right.active).toBeUndefined();
    expect(right.containers.map((container) => container.id)).toEqual(["c.a", "c.b", "c.c"]);
});

test("closing a tab that is not active leaves the active one alone, and an unknown tab changes nothing", () => {
    const state = onPanes(defaultLayout(), open("c.a"), open("c.b"));
    const after = onPanes(state, close("tab.1"));
    expect(strip(after)).toEqual(["tab.2:c.b"]);
    expect(activeTab(after)).toBe("tab.2");
    expect(onPanes(state, close("missing"))).toBe(state);
});

test("a tab id is not used again after its tab closes", () => {
    const state = onPanes(defaultLayout(), open("c.a"), close("tab.1"), open("c.a"));
    expect(strip(state)).toEqual(["tab.2:c.a"]);
});

test("a caller can name a new tab, and a name already in use opens nothing", () => {
    const state = onPanes(defaultLayout(), open("c.a", "tab.page-1"));
    expect(strip(state)).toEqual(["tab.page-1:c.a"]);
    expect(onPanes(state, open("c.b", "tab.page-1"))).toBe(state);
    expect(strip(onPanes(state, open("c.b")))).toEqual(["tab.page-1:c.a", "tab.1:c.b"]);
});

test("moving a tab reorders the strip", () => {
    const state = onPanes(defaultLayout(), open("c.a"), open("c.b"), open("c.a"));
    expect(strip(onPanes(state, { type: "moveTab", tab: "tab.3", index: 0 }))).toEqual(["tab.3:c.a", "tab.1:c.a", "tab.2:c.b"]);
    expect(strip(onPanes(state, { type: "moveTab", tab: "tab.1", index: 2 }))).toEqual(["tab.2:c.b", "tab.3:c.a", "tab.1:c.a"]);
    expect(onPanes(state, { type: "moveTab", tab: "tab.2", index: 1 })).toBe(state);
    expect(onPanes(state, { type: "moveTab", tab: "missing", index: 0 })).toBe(state);
});

test("a container with a tab limit refuses another tab, and so does a full pane", () => {
    const limited = onPanes(defaultLayout(), open("c.c"), open("c.c"));
    expect(onPanes(limited, open("c.c"))).toBe(limited);
    expect(onPanes(limited, activate("c.c")).tabs).toHaveLength(2);
    const full = Array.from({ length: MAX_TABS }).reduce<LayoutState>((next) => onPanes(next, open("c.a")), defaultLayout());
    expect(full.tabs).toHaveLength(MAX_TABS);
    expect(onPanes(full, open("c.b"))).toBe(full);
});

test("opening a tab for a container outside the right pane, or an unknown one, changes nothing", () => {
    const state = onPanes(defaultLayout(), open("c.a"));
    expect(onPanes(state, open("c.sessions"))).toBe(state);
    expect(onPanes(state, open("missing"))).toBe(state);
});

test("the sidebar and panel keep showing every container, whatever the tabs are", () => {
    const state = onPanes(defaultLayout(), activate("c.output"), activate("c.sessions"), open("c.a"));
    const layout = resolveLayout(state, PANES);
    expect(layout.locations.sidebar.containers.map((container) => container.id)).toEqual(["c.sessions"]);
    expect(layout.locations.panel.containers.map((container) => container.id)).toEqual(["c.output"]);
    expect(layout.locations.panel.visible).toBe(true);
    expect(layout.locations.panel.active?.id).toBe("c.output");
});

test("@core a container dragged into the right pane opens one tab there", () => {
    const base = onPanes(defaultLayout(), open("c.a"), open("c.c"));
    const state = onPanes(base, { type: "moveContainer", container: "c.output", location: "rightPane" });
    expect(strip(state)).toEqual(["tab.1:c.a", "tab.2:c.c", "tab.3:c.output"]);
    expect(activeTab(state)).toBe("tab.3");
    expect(resolveLayout(state, PANES).locations.panel.containers).toEqual([]);
});

test("@core a container dragged out of the right pane closes all of its tabs", () => {
    const base = onPanes(defaultLayout(), open("c.a"), open("c.b"), open("c.b"), open("c.a"));
    const state = onPanes(base, { type: "moveContainer", container: "c.b", location: "panel" });
    expect(strip(state)).toEqual(["tab.1:c.a", "tab.4:c.a"]);
    expect(activeTab(state)).toBe("tab.4");
    const panel = resolveLayout(state, PANES).locations.panel;
    expect(panel.containers.map((container) => container.id)).toEqual(["c.output", "c.b"]);
    expect(panel.active?.id).toBe("c.b");
    const back = onPanes(state, { type: "moveContainer", container: "c.b", location: "rightPane" });
    expect(strip(back).filter((entry) => entry.endsWith(":c.b"))).toHaveLength(1);
});

test("@core a view dragged into the right pane opens the container it lands in", () => {
    const closed = onPanes(defaultLayout(), { type: "moveView", view: "v.output", to: { container: "c.b" } });
    expect(strip(closed)).toEqual(["tab.1:c.b"]);
    const fresh = onPanes(defaultLayout(), { type: "moveView", view: "v.output", to: { location: "rightPane" } });
    const tabs = resolveLayout(fresh, PANES).locations.rightPane.tabs;
    expect(tabs.map((tab) => tab.container.generated)).toEqual([true]);
    expect(tabs[0]!.container.views.map((view) => view.id)).toEqual(["v.output"]);
});

test("a generated container that goes away takes its tabs with it", () => {
    const moved = onPanes(defaultLayout(), { type: "moveView", view: "v.output", to: { location: "rightPane" } });
    expect(moved.tabs).toHaveLength(1);
    const home = onPanes(moved, { type: "resetView", view: "v.output" });
    expect(home.tabs).toEqual([]);
    expect(activeTab(home)).toBeUndefined();
});

test("hiding a container closes its tabs, and showing it opens one tab", () => {
    const state = onPanes(defaultLayout(), open("c.a"), open("c.b"), open("c.b"));
    const hidden = onPanes(state, { type: "setContainerHidden", container: "c.b", hidden: true });
    expect(strip(hidden)).toEqual(["tab.1:c.a"]);
    expect(resolveLayout(hidden, PANES).locations.rightPane.containers.map((container) => container.id)).toEqual(["c.a", "c.c"]);
    expect(onPanes(hidden, activate("c.b"))).toBe(hidden);
    expect(strip(onPanes(hidden, { type: "setContainerHidden", container: "c.b", hidden: false }))).toEqual(["tab.1:c.a", "tab.4:c.b"]);
});

test("resetting the layout closes every tab, and resetting a container sent elsewhere closes its tabs", () => {
    const state = onPanes(defaultLayout(), open("c.a"), open("c.b"));
    expect(onPanes(state, { type: "resetLayout" }).tabs).toEqual([]);
    const moved = onPanes(state, { type: "moveContainer", container: "c.output", location: "rightPane" });
    expect(strip(onPanes(moved, { type: "resetContainer", container: "c.output" }))).toEqual(["tab.1:c.a", "tab.2:c.b"]);
});

test("tabs of a container whose flag is off stay in the layout without being shown", () => {
    const state = onPanes(defaultLayout(), open("c.a"), open("c.b"));
    const without: RegistrySnapshot = {
        containers: PANES.containers.filter((container) => container.id !== "c.b"),
        views: PANES.views.filter((view) => view.container !== "c.b"),
    };
    const right = resolveLayout(state, without).locations.rightPane;
    expect(right.tabs.map((tab) => tab.id)).toEqual(["tab.1"]);
    expect(right.activeTab?.id).toBe("tab.1");
    expect(state.tabs.map((tab) => tab.id)).toEqual(["tab.1", "tab.2"]);
    expect(resolveLayout(state, PANES).locations.rightPane.tabs.map((tab) => tab.id)).toEqual(["tab.1", "tab.2"]);
});
