import type { LayoutState, LocationId, RegistrySnapshot } from "./model.ts";
import { LOCATIONS, MAX_TABS } from "./model.ts";

export interface ResolvedView {
    readonly id: string;
    readonly title: string;
    readonly container: string;
    readonly hidden: boolean;
    readonly collapsed: boolean;
}

export interface ResolvedContainer {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly location: LocationId;
    readonly generated: boolean;
    readonly hidden: boolean;
    // Every view in the container, in order, hidden ones included.
    readonly views: readonly ResolvedView[];
    // The container appears only while it has a visible view and is not hidden itself.
    readonly shown: boolean;
    // Tabs of this kind in the right pane, and the most it holds at once (absent for no limit).
    readonly tabCount: number;
    readonly maxTabs: number | undefined;
}

// One tab in the right pane. Two tabs can show the same container.
export interface ResolvedTab {
    readonly id: string;
    readonly container: ResolvedContainer;
}

export interface ResolvedLocation {
    readonly id: LocationId;
    readonly visible: boolean;
    readonly size: number;
    // Containers that appear in the location, in order.
    readonly containers: readonly ResolvedContainer[];
    // The right pane's tabs in strip order; empty elsewhere. Tabs of containers that are not shown are left out.
    readonly tabs: readonly ResolvedTab[];
    readonly activeTab: ResolvedTab | undefined;
    // Every container placed here in order, hidden and empty ones included.
    readonly all: readonly ResolvedContainer[];
    // In the right pane the container of the active tab, and none while the pane has no tabs.
    readonly active: ResolvedContainer | undefined;
}

export interface ResolvedLayout {
    readonly locations: Readonly<Record<LocationId, ResolvedLocation>>;
    readonly containers: readonly ResolvedContainer[];
    // Every tab in the layout, those of containers that are not shown included; the pane holds at most MAX_TABS.
    readonly tabTotal: number;
    // Tab ids, the most recently active first.
    readonly recentTabs: readonly string[];
}

interface ContainerDefinition {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly defaultLocation: LocationId;
    readonly generated: boolean;
    readonly maxTabs: number | undefined;
}

// Orders ids by their place in a saved list; ids the list does not name keep their
// original order after the listed ones.
function ordered<T>(items: readonly T[], idOf: (item: T) => string, saved: readonly string[] | undefined): T[] {
    if (saved === undefined || saved.length === 0) return [...items];
    const rank = new Map<string, number>();
    saved.forEach((id, index) => {
        if (!rank.has(id)) rank.set(id, index);
    });
    const listed = items.filter((item) => rank.has(idOf(item)));
    const rest = items.filter((item) => !rank.has(idOf(item)));
    listed.sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
    return [...listed, ...rest];
}

// Saved state wins over defaults. A saved id the registry does not know is skipped
// here and kept in the saved state.
export function resolveLayout(state: LayoutState, registry: RegistrySnapshot): ResolvedLayout {
    const definitions = new Map<string, ContainerDefinition>();
    for (const container of registry.containers) {
        definitions.set(container.id, {
            id: container.id,
            title: container.title,
            icon: container.icon,
            defaultLocation: container.location,
            generated: false,
            maxTabs: container.maxTabs,
        });
    }
    for (const [id, generated] of Object.entries(state.generated)) {
        if (definitions.has(id)) continue;
        definitions.set(id, {
            id,
            title: generated.title,
            icon: generated.icon,
            defaultLocation: "sidebar",
            generated: true,
            maxTabs: undefined,
        });
    }

    const viewsByContainer = new Map<string, typeof registry.views[number][]>();
    for (const view of registry.views) {
        const saved = state.viewContainer[view.id];
        const containerId = saved !== undefined && definitions.has(saved) ? saved : view.container;
        if (!definitions.has(containerId)) continue;
        const list = viewsByContainer.get(containerId) ?? [];
        list.push(view);
        viewsByContainer.set(containerId, list);
    }

    const hiddenContainers = new Set(state.hiddenContainers);
    const tabCounts = new Map<string, number>();
    for (const tab of state.tabs) tabCounts.set(tab.container, (tabCounts.get(tab.container) ?? 0) + 1);
    const hiddenViews = new Set(state.hiddenViews);
    const collapsedViews = new Set(state.collapsedViews);
    const resolved = new Map<string, ResolvedContainer>();
    for (const definition of definitions.values()) {
        const views = ordered(viewsByContainer.get(definition.id) ?? [], (view) => view.id, state.viewOrder[definition.id])
            .map((view): ResolvedView => ({
                id: view.id,
                title: view.title,
                container: definition.id,
                hidden: hiddenViews.has(view.id),
                collapsed: collapsedViews.has(view.id),
            }));
        const hidden = hiddenContainers.has(definition.id);
        const location = state.containerLocation[definition.id] ?? definition.defaultLocation;
        const shown = !hidden && views.some((view) => !view.hidden);
        resolved.set(definition.id, {
            id: definition.id,
            title: definition.title,
            icon: definition.icon,
            location,
            generated: definition.generated,
            hidden,
            views,
            shown,
            tabCount: tabCounts.get(definition.id) ?? 0,
            maxTabs: definition.maxTabs,
        });
    }

    const locations = {} as Record<LocationId, ResolvedLocation>;
    for (const location of LOCATIONS) {
        const all = ordered(
            [...resolved.values()].filter((container) => container.location === location),
            (container) => container.id,
            state.containerOrder[location],
        );
        const here = all.filter((container) => container.shown);
        const saved = state.locations[location];
        const tabs = location === "rightPane"
            ? state.tabs.flatMap((tab): ResolvedTab[] => {
                const container = here.find((candidate) => candidate.id === tab.container);
                return container === undefined ? [] : [{ id: tab.id, container }];
            })
            : [];
        const activeTab = tabs.find((tab) => tab.id === saved.active) ?? tabs[0];
        locations[location] = {
            id: location,
            visible: saved.visible,
            size: saved.size,
            containers: here,
            tabs,
            activeTab,
            all,
            active: location === "rightPane" ? activeTab?.container : here.find((container) => container.id === saved.active) ?? here[0],
        };
    }
    return { locations, containers: [...resolved.values()], tabTotal: state.tabs.length, recentTabs: state.recentTabs };
}

export function findView(layout: ResolvedLayout, viewId: string): ResolvedView | undefined {
    for (const container of layout.containers) {
        const view = container.views.find((candidate) => candidate.id === viewId);
        if (view !== undefined) return view;
    }
    return undefined;
}

export function findContainer(layout: ResolvedLayout, containerId: string): ResolvedContainer | undefined {
    return layout.containers.find((container) => container.id === containerId);
}

// Whether another tab of the container can open: it is shown in the right pane and neither its own
// limit nor the pane's has been reached.
export function canOpenTab(layout: ResolvedLayout, containerId: string): boolean {
    const container = findContainer(layout, containerId);
    if (container === undefined || !container.shown || container.location !== "rightPane") return false;
    if (layout.tabTotal >= MAX_TABS) return false;
    return container.maxTabs === undefined || container.tabCount < container.maxTabs;
}
