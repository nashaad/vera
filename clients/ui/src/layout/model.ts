export const LOCATIONS = ["sidebar", "rightPane", "panel"] as const;
export type LocationId = (typeof LOCATIONS)[number];

export const LOCATION_TITLES: Readonly<Record<LocationId, string>> = {
    sidebar: "Sidebar",
    rightPane: "Right Pane",
    panel: "Panel",
};

// Layout sizes are not theme: widths for the sidebar and right pane, height for the panel.
export const LOCATION_SIZES: Readonly<Record<LocationId, { initial: number; min: number; max: number }>> = {
    sidebar: { initial: 256, min: 160, max: 640 },
    rightPane: { initial: 440, min: 240, max: 900 },
    panel: { initial: 240, min: 80, max: 600 },
};

export const MAIN_MIN_WIDTH = 320;

export function isLocationId(value: unknown): value is LocationId {
    return typeof value === "string" && (LOCATIONS as readonly string[]).includes(value);
}

export function clampSize(location: LocationId, size: number): number {
    const { min, max } = LOCATION_SIZES[location];
    return Math.min(max, Math.max(min, Math.round(size)));
}

// A contribution names a default container (views) or a default location (containers),
// never a position. The shape is internal until extensions can register.
export interface ContainerContribution {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly location: LocationId;
}

export interface ViewContribution {
    readonly id: string;
    readonly title: string;
    readonly container: string;
}

export interface RegistrySnapshot {
    readonly containers: readonly ContainerContribution[];
    readonly views: readonly ViewContribution[];
}

export interface LocationState {
    readonly visible: boolean;
    readonly size: number;
    readonly active?: string;
}

// A container made by dragging a view out on its own; it has no registered default.
export interface GeneratedContainer {
    readonly title: string;
    readonly icon: string;
}

// The saved layout holds only what the person changed, plus explicit order lists.
// Ids that are no longer registered stay in it so a re-registered view returns.
export interface LayoutState {
    readonly version: 1;
    readonly locations: Readonly<Record<LocationId, LocationState>>;
    readonly containerLocation: Readonly<Record<string, LocationId>>;
    readonly containerOrder: Readonly<Record<LocationId, readonly string[]>>;
    readonly viewContainer: Readonly<Record<string, string>>;
    readonly viewOrder: Readonly<Record<string, readonly string[]>>;
    readonly hiddenContainers: readonly string[];
    readonly hiddenViews: readonly string[];
    readonly collapsedViews: readonly string[];
    readonly generated: Readonly<Record<string, GeneratedContainer>>;
}

export function defaultLayout(): LayoutState {
    return {
        version: 1,
        locations: {
            sidebar: { visible: true, size: LOCATION_SIZES.sidebar.initial },
            rightPane: { visible: false, size: LOCATION_SIZES.rightPane.initial },
            panel: { visible: false, size: LOCATION_SIZES.panel.initial },
        },
        containerLocation: {},
        containerOrder: { sidebar: [], rightPane: [], panel: [] },
        viewContainer: {},
        viewOrder: {},
        hiddenContainers: [],
        hiddenViews: [],
        collapsedViews: [],
        generated: {},
    };
}
