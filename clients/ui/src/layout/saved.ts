import {
    clampSize,
    defaultLayout,
    isLocationId,
    type GeneratedContainer,
    type LayoutState,
    type LocationId,
    LOCATIONS,
} from "./model.ts";

// Caps keep a damaged or hostile file from growing the layout without bound.
const MAX_IDS = 512;
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 128;

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function idOf(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function idList(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const entry of value) {
        const id = idOf(entry);
        if (id !== undefined && seen.size < MAX_IDS) seen.add(id);
    }
    return [...seen];
}

function entries(value: unknown): Array<[string, unknown]> {
    const source = record(value);
    return source === undefined ? [] : Object.entries(source).slice(0, MAX_IDS);
}

// Returns undefined when the value is not a layout this build can read. Fields that are
// wrong inside a readable layout fall back to their defaults one by one.
export function parseLayout(value: unknown): LayoutState | undefined {
    const source = record(value);
    if (source === undefined || source.version !== 1) return undefined;
    const base = defaultLayout();

    const locations = { ...base.locations };
    const savedLocations = record(source.locations);
    for (const location of LOCATIONS) {
        const saved = record(savedLocations?.[location]);
        if (saved === undefined) continue;
        const active = idOf(saved.active);
        locations[location] = {
            visible: typeof saved.visible === "boolean" ? saved.visible : base.locations[location].visible,
            size: typeof saved.size === "number" && Number.isFinite(saved.size)
                ? clampSize(location, saved.size)
                : base.locations[location].size,
            ...(active === undefined ? {} : { active }),
        };
    }

    const containerLocation: Record<string, LocationId> = {};
    for (const [id, location] of entries(source.containerLocation)) {
        if (idOf(id) !== undefined && isLocationId(location)) containerLocation[id] = location;
    }

    const containerOrder = { ...base.containerOrder };
    const savedOrder = record(source.containerOrder);
    for (const location of LOCATIONS) {
        containerOrder[location] = idList(savedOrder?.[location]);
    }

    const viewContainer: Record<string, string> = {};
    for (const [id, container] of entries(source.viewContainer)) {
        const target = idOf(container);
        if (idOf(id) !== undefined && target !== undefined) viewContainer[id] = target;
    }

    const viewOrder: Record<string, readonly string[]> = {};
    for (const [id, list] of entries(source.viewOrder)) {
        if (idOf(id) !== undefined) viewOrder[id] = idList(list);
    }

    const generated: Record<string, GeneratedContainer> = {};
    for (const [id, container] of entries(source.generated)) {
        const saved = record(container);
        if (idOf(id) === undefined || saved === undefined) continue;
        if (typeof saved.title !== "string" || typeof saved.icon !== "string") continue;
        generated[id] = { title: saved.title.slice(0, MAX_TITLE_LENGTH), icon: saved.icon.slice(0, MAX_ID_LENGTH) };
    }

    return {
        version: 1,
        locations,
        containerLocation,
        containerOrder,
        viewContainer,
        viewOrder,
        hiddenContainers: idList(source.hiddenContainers),
        hiddenViews: idList(source.hiddenViews),
        collapsedViews: idList(source.collapsedViews),
        generated,
    };
}
