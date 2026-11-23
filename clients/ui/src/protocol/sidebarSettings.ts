import type { SidebarGrouping } from "./sidebarTree.ts";

// The desktop keeps this in its own file under the home.
export interface SidebarSettings {
    readonly groupBy: SidebarGrouping;
}

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = { groupBy: "none" };

export function isSidebarGrouping(value: unknown): value is SidebarGrouping {
    return value === "none" || value === "folder";
}

// Any other shape is damage, not a guess: the caller falls back to the default.
export function parseSidebarSettings(value: unknown): SidebarSettings | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const groupBy = (value as Record<string, unknown>).groupBy;
    return isSidebarGrouping(groupBy) ? { groupBy } : undefined;
}
