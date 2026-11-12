import type { LayoutState, LocationId, RegistrySnapshot } from "./model.ts";
import { LOCATIONS } from "./model.ts";

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
}

export interface ResolvedLocation {
    readonly id: LocationId;
    readonly visible: boolean;
    readonly size: number;
    // Containers that appear in the location, in order.
    readonly containers: readonly ResolvedContainer[];
    // Every container placed here in order, hidden and empty ones included.
    readonly all: readonly ResolvedContainer[];
    readonly active: ResolvedContainer | undefined;
}

export interface ResolvedLayout {
    readonly locations: Readonly<Record<LocationId, ResolvedLocation>>;
    readonly containers: readonly ResolvedContainer[];
}

interface ContainerDefinition {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly defaultLocation: LocationId;
    readonly generated: boolean;
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
        resolved.set(definition.id, {
            id: definition.id,
            title: definition.title,
            icon: definition.icon,
            location: state.containerLocation[definition.id] ?? definition.defaultLocation,
            generated: definition.generated,
            hidden,
            views,
            shown: !hidden && views.some((view) => !view.hidden),
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
        locations[location] = {
            id: location,
            visible: saved.visible,
            size: saved.size,
            containers: here,
            all,
            active: here.find((container) => container.id === saved.active) ?? here[0],
        };
    }
    return { locations, containers: [...resolved.values()] };
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
