import {
    clampSize,
    defaultLayout,
    isLocationId,
    type GeneratedContainer,
    type LayoutState,
    type LocationId,
    LOCATIONS,
    MAX_TABS,
    type PaneTab,
} from "./model.ts";
import { dropTabs, highestTabNumber } from "./tabs.ts";

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

interface ParsedTabs {
    readonly tabs: readonly PaneTab[];
    readonly recentTabs: readonly string[];
    readonly tabSeq: number;
    // The id of the pane's active tab.
    readonly active: string | undefined;
}

// A layout saved before the pane had tabs names its active right-pane container, which opens as one tab.
// With nothing active it loads with no tabs.
function parseTabs(source: Record<string, unknown>, savedActive: string | undefined): ParsedTabs {
    if (!Array.isArray(source.tabs)) {
        if (savedActive === undefined) return { tabs: [], recentTabs: [], tabSeq: 0, active: undefined };
        return { tabs: [{ id: "tab.1", container: savedActive }], recentTabs: ["tab.1"], tabSeq: 1, active: "tab.1" };
    }
    const tabs: PaneTab[] = [];
    for (const entry of source.tabs) {
        const saved = record(entry);
        const id = idOf(saved?.id);
        const container = idOf(saved?.container);
        if (id === undefined || container === undefined || tabs.length >= MAX_TABS) continue;
        if (tabs.some((tab) => tab.id === id)) continue;
        tabs.push({ id, container });
    }
    const ids = new Set(tabs.map((tab) => tab.id));
    const recentTabs = idList(source.recentTabs).filter((id) => ids.has(id));
    const savedSeq = typeof source.tabSeq === "number" && Number.isSafeInteger(source.tabSeq) && source.tabSeq > 0 ? source.tabSeq : 0;
    return {
        tabs,
        recentTabs,
        tabSeq: Math.max(savedSeq, highestTabNumber(tabs)),
        active: tabs.some((tab) => tab.id === savedActive) ? savedActive : undefined,
    };
}

// What is written to disk: tabs of kinds that do not survive a restart are left out, and the pane's
// active tab moves to a neighbour when it was one of them.
export function forSave(state: LayoutState, transient: (container: string) => boolean): LayoutState {
    return dropTabs(state, (tab) => transient(tab.container));
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

    const { tabs, recentTabs, tabSeq, active } = parseTabs(source, locations.rightPane.active);
    const { active: _saved, ...rightPane } = locations.rightPane;
    locations.rightPane = active === undefined ? rightPane : { ...rightPane, active };

    return {
        version: 1,
        locations,
        containerLocation,
        containerOrder,
        viewContainer,
        viewOrder,
        hiddenContainers: idList(source.hiddenContainers),
        tabs,
        recentTabs,
        tabSeq,
        hiddenViews: idList(source.hiddenViews),
        collapsedViews: idList(source.collapsedViews),
        generated,
    };
}
