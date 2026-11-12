import {
    clampSize,
    defaultLayout,
    type LayoutState,
    type LocationId,
    LOCATIONS,
    type RegistrySnapshot,
} from "./model.ts";
import { findContainer, findView, resolveLayout, type ResolvedLayout } from "./resolve.ts";

export type ViewDestination =
    | { readonly container: string; readonly index?: number }
    // A location makes a new container there that holds only this view.
    | { readonly location: LocationId; readonly index?: number };

export type LayoutAction =
    | { readonly type: "toggleLocation"; readonly location: LocationId }
    | { readonly type: "setLocationVisible"; readonly location: LocationId; readonly visible: boolean }
    | { readonly type: "resizeLocation"; readonly location: LocationId; readonly size: number }
    | { readonly type: "activateContainer"; readonly container: string }
    | { readonly type: "moveView"; readonly view: string; readonly to: ViewDestination }
    | {
        readonly type: "moveContainer";
        readonly container: string;
        readonly location: LocationId;
        readonly index?: number;
    }
    | { readonly type: "setViewHidden"; readonly view: string; readonly hidden: boolean }
    | { readonly type: "setContainerHidden"; readonly container: string; readonly hidden: boolean }
    | { readonly type: "setViewCollapsed"; readonly view: string; readonly collapsed: boolean }
    | { readonly type: "resetView"; readonly view: string }
    | { readonly type: "resetContainer"; readonly container: string }
    | { readonly type: "resetLayout" };

// Pure: the registry snapshot is an argument so ids it does not know are left alone.
// A no-op returns the same state object, so callers can skip saving.
export function reduceLayout(
    state: LayoutState,
    action: LayoutAction,
    registry: RegistrySnapshot,
): LayoutState {
    switch (action.type) {
        case "toggleLocation":
            return withLocation(state, action.location, { visible: !state.locations[action.location].visible });
        case "setLocationVisible":
            return withLocation(state, action.location, { visible: action.visible });
        case "resizeLocation":
            return withLocation(state, action.location, { size: clampSize(action.location, action.size) });
        case "activateContainer":
            return reveal(state, resolveLayout(state, registry), action.container);
        case "moveView":
            return moveView(state, registry, action.view, action.to);
        case "moveContainer":
            return moveContainer(state, registry, action.container, action.location, action.index);
        case "setViewHidden":
            return setViewHidden(state, registry, action.view, action.hidden);
        case "setContainerHidden":
            return setContainerHidden(state, registry, action.container, action.hidden);
        case "setViewCollapsed":
            return withList(state, "collapsedViews", action.view, action.collapsed);
        case "resetView":
            return resetView(state, registry, action.view);
        case "resetContainer":
            return resetContainer(state, registry, action.container);
        case "resetLayout":
            return defaultLayout();
    }
}

function withLocation(
    state: LayoutState,
    location: LocationId,
    change: Partial<LayoutState["locations"][LocationId]>,
): LayoutState {
    const current = state.locations[location];
    const next = { ...current, ...change };
    if (next.visible === current.visible && next.size === current.size && next.active === current.active) {
        return state;
    }
    return { ...state, locations: { ...state.locations, [location]: next } };
}

function withList(
    state: LayoutState,
    key: "hiddenContainers" | "hiddenViews" | "collapsedViews",
    id: string,
    present: boolean,
): LayoutState {
    const list = state[key];
    if (list.includes(id) === present) return state;
    return { ...state, [key]: present ? [...list, id] : list.filter((entry) => entry !== id) };
}

// Makes the container's location visible and the container its active one.
function reveal(state: LayoutState, layout: ResolvedLayout, containerId: string): LayoutState {
    const container = findContainer(layout, containerId);
    if (container === undefined || !container.shown) return state;
    return withLocation(state, container.location, { visible: true, active: container.id });
}

function without(list: readonly string[], id: string): readonly string[] {
    return list.includes(id) ? list.filter((entry) => entry !== id) : list;
}

// Puts `id` into `full` (the current order, hidden entries included, `id` excluded) before
// the entry at `index` of `shown`, or last when the index is absent or past the end.
function insertAt(full: readonly string[], shown: readonly string[], id: string, index: number | undefined): string[] {
    const anchor = index === undefined ? undefined : shown[index];
    const at = anchor === undefined ? -1 : full.indexOf(anchor);
    const next = [...full];
    if (at === -1) next.push(id);
    else next.splice(at, 0, id);
    return next;
}

// An order list written from the current layout. Ids it named that are not registered stay at the end.
function writeOrder(previous: readonly string[] | undefined, current: readonly string[]): readonly string[] {
    const known = new Set(current);
    return [...current, ...(previous ?? []).filter((id) => !known.has(id))];
}

function dropFromViewOrders(
    orders: LayoutState["viewOrder"],
    view: string,
    keep?: string,
): LayoutState["viewOrder"] {
    const next: Record<string, readonly string[]> = {};
    for (const [container, list] of Object.entries(orders)) {
        next[container] = container === keep ? list : without(list, view);
    }
    return next;
}

function dropFromContainerOrders(
    orders: LayoutState["containerOrder"],
    container: string,
    keep?: LocationId,
): LayoutState["containerOrder"] {
    const next = {} as Record<LocationId, readonly string[]>;
    for (const location of LOCATIONS) {
        next[location] = location === keep ? orders[location] : without(orders[location], container);
    }
    return next;
}

function freshContainerId(state: LayoutState, view: string): string {
    let n = 1;
    while (`generated.${view}.${n}` in state.generated) n += 1;
    return `generated.${view}.${n}`;
}

function moveView(
    state: LayoutState,
    registry: RegistrySnapshot,
    viewId: string,
    to: ViewDestination,
): LayoutState {
    const layout = resolveLayout(state, registry);
    const view = findView(layout, viewId);
    const registered = registry.views.find((candidate) => candidate.id === viewId);
    const from = view === undefined ? undefined : findContainer(layout, view.container);
    if (view === undefined || registered === undefined || from === undefined) return state;

    let next = state;
    let targetId: string;
    let index: number | undefined;
    if ("container" in to) {
        const target = findContainer(layout, to.container);
        if (target === undefined) return state;
        targetId = target.id;
        index = to.index;
    } else {
        if (from.generated && from.views.length === 1 && from.location === to.location) {
            return reveal(state, layout, from.id);
        }
        targetId = freshContainerId(state, viewId);
        next = {
            ...next,
            generated: { ...next.generated, [targetId]: { title: view.title, icon: from.icon } },
            containerLocation: { ...next.containerLocation, [targetId]: to.location },
            containerOrder: {
                ...next.containerOrder,
                [to.location]: writeOrder(
                    next.containerOrder[to.location],
                    insertAt(
                        layout.locations[to.location].all.map((c) => c.id),
                        layout.locations[to.location].containers.map((c) => c.id),
                        targetId,
                        to.index,
                    ),
                ),
            },
        };
        index = 0;
    }

    const target = findContainer(layout, targetId);
    const members = (target?.views ?? []).filter((member) => member.id !== viewId);
    const order = insertAt(
        members.map((member) => member.id),
        members.filter((member) => !member.hidden).map((member) => member.id),
        viewId,
        index,
    );
    const viewContainer = { ...next.viewContainer };
    if (targetId === registered.container) delete viewContainer[viewId];
    else viewContainer[viewId] = targetId;
    next = {
        ...next,
        viewContainer,
        viewOrder: {
            ...dropFromViewOrders(next.viewOrder, viewId, targetId),
            [targetId]: writeOrder(next.viewOrder[targetId]?.filter((id) => id !== viewId), order),
        },
        hiddenViews: without(next.hiddenViews, viewId),
    };
    next = pruneGenerated(next);
    return reveal(next, resolveLayout(next, registry), targetId);
}

function moveContainer(
    state: LayoutState,
    registry: RegistrySnapshot,
    containerId: string,
    location: LocationId,
    index: number | undefined,
): LayoutState {
    const layout = resolveLayout(state, registry);
    const container = findContainer(layout, containerId);
    if (container === undefined) return state;
    const registered = registry.containers.find((candidate) => candidate.id === containerId);

    const siblings = layout.locations[location].containers.filter((sibling) => sibling.id !== containerId);
    const full = layout.locations[location].all.filter((sibling) => sibling.id !== containerId);
    const order = insertAt(full.map((sibling) => sibling.id), siblings.map((sibling) => sibling.id), containerId, index);
    const containerLocation = { ...state.containerLocation };
    if (registered !== undefined && registered.location === location) delete containerLocation[containerId];
    else containerLocation[containerId] = location;
    let next: LayoutState = {
        ...state,
        containerLocation,
        containerOrder: {
            ...dropFromContainerOrders(state.containerOrder, containerId, location),
            [location]: writeOrder(state.containerOrder[location].filter((id) => id !== containerId), order),
        },
    };
    const previous = next.locations[container.location];
    if (container.location !== location && previous.active === containerId) {
        next = withLocation(next, container.location, { active: undefined });
    }
    return reveal(next, resolveLayout(next, registry), containerId);
}

function setViewHidden(state: LayoutState, registry: RegistrySnapshot, viewId: string, hidden: boolean): LayoutState {
    const next = withList(state, "hiddenViews", viewId, hidden);
    if (hidden || next === state) return next;
    const view = findView(resolveLayout(state, registry), viewId);
    if (view === undefined) return next;
    const shown = withList(next, "hiddenContainers", view.container, false);
    return reveal(shown, resolveLayout(shown, registry), view.container);
}

function setContainerHidden(
    state: LayoutState,
    registry: RegistrySnapshot,
    containerId: string,
    hidden: boolean,
): LayoutState {
    let next = withList(state, "hiddenContainers", containerId, hidden);
    if (hidden) return next;
    const container = findContainer(resolveLayout(state, registry), containerId);
    if (container === undefined) return next;
    // A container whose views are all hidden would show nothing, so showing it shows them.
    if (container.views.length > 0 && container.views.every((view) => view.hidden)) {
        const ids = new Set(container.views.map((view) => view.id));
        next = { ...next, hiddenViews: next.hiddenViews.filter((id) => !ids.has(id)) };
    }
    return reveal(next, resolveLayout(next, registry), containerId);
}

function resetView(state: LayoutState, registry: RegistrySnapshot, viewId: string): LayoutState {
    const registered = registry.views.find((candidate) => candidate.id === viewId);
    if (registered === undefined) return state;
    const viewContainer = { ...state.viewContainer };
    delete viewContainer[viewId];
    const next = pruneGenerated({
        ...state,
        viewContainer,
        viewOrder: dropFromViewOrders(state.viewOrder, viewId),
    });
    const view = findView(resolveLayout(state, registry), viewId);
    if (view === undefined || view.hidden) return next;
    return reveal(next, resolveLayout(next, registry), registered.container);
}

function resetContainer(state: LayoutState, registry: RegistrySnapshot, containerId: string): LayoutState {
    const container = findContainer(resolveLayout(state, registry), containerId);
    if (container === undefined) return state;
    if (container.generated) {
        return container.views.reduce((next, view) => resetView(next, registry, view.id), state);
    }
    const containerLocation = { ...state.containerLocation };
    delete containerLocation[containerId];
    const next = {
        ...state,
        containerLocation,
        containerOrder: dropFromContainerOrders(state.containerOrder, containerId),
    };
    return reveal(next, resolveLayout(next, registry), containerId);
}

// A generated container lives only while some saved view points at it.
function pruneGenerated(state: LayoutState): LayoutState {
    const used = new Set(Object.values(state.viewContainer));
    const stale = Object.keys(state.generated).filter((id) => !used.has(id));
    if (stale.length === 0) return state;
    const gone = new Set(stale);
    const generated = { ...state.generated };
    const containerLocation = { ...state.containerLocation };
    const viewOrder = { ...state.viewOrder };
    const locations = { ...state.locations };
    for (const id of stale) {
        delete generated[id];
        delete containerLocation[id];
        delete viewOrder[id];
    }
    for (const location of LOCATIONS) {
        if (locations[location].active !== undefined && gone.has(locations[location].active)) {
            locations[location] = { ...locations[location], active: undefined };
        }
    }
    return {
        ...state,
        generated,
        containerLocation,
        viewOrder,
        locations,
        containerOrder: {
            sidebar: state.containerOrder.sidebar.filter((id) => !gone.has(id)),
            rightPane: state.containerOrder.rightPane.filter((id) => !gone.has(id)),
            panel: state.containerOrder.panel.filter((id) => !gone.has(id)),
        },
        hiddenContainers: state.hiddenContainers.filter((id) => !gone.has(id)),
    };
}
