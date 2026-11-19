import { BROWSER_HISTORY_COMMAND } from "../commands/keys.ts";
import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { NAVIGATION_COMMANDS } from "../commands/navigation-commands.ts";
import { OVERLAY_COMMANDS } from "../commands/overlay-ids.ts";
import { PAGE_COMMANDS } from "../commands/page-commands.ts";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { FLAG_KEYS, type DesktopFlags, type FlagKey } from "./desktopFlags.ts";

// What the window has seen so far. Each field only turns on, so a part that appeared stays until the window closes.
export interface SurfaceEvidence {
    // The most sessions the host has listed.
    readonly sessions: number;
    // The host has attached, so Customize can read what a new chat loads.
    readonly hostReady: boolean;
    // The open session has made changes, shown a checklist, reported context use, or has a files folder.
    readonly review: boolean;
    readonly plan: boolean;
    readonly files: boolean;
    readonly context: boolean;
    // The connection log has held a warning or an error.
    readonly output: boolean;
    // The host connection has failed or dropped.
    readonly hostFailed: boolean;
}

export const NO_EVIDENCE: SurfaceEvidence = {
    sessions: 0,
    hostReady: false,
    review: false,
    plan: false,
    files: false,
    context: false,
    output: false,
    hostFailed: false,
};

export type Visibility = Readonly<Record<FlagKey, boolean>>;

export const ALL_VISIBLE: Visibility = Object.fromEntries(FLAG_KEYS.map((key) => [key, true])) as Record<FlagKey, boolean>;

// The condition an Auto flag waits for. A part with no entry here offers no Auto.
const AUTO_CONDITIONS: Readonly<Partial<Record<FlagKey, (evidence: SurfaceEvidence) => boolean>>> = {
    search: (evidence) => evidence.sessions >= 1,
    work: (evidence) => evidence.sessions >= 2,
    customize: (evidence) => evidence.hostReady,
    review: (evidence) => evidence.review,
    plan: (evidence) => evidence.plan,
    files: (evidence) => evidence.files,
    output: (evidence) => evidence.output,
    contextPill: (evidence) => evidence.context,
    doctor: (evidence) => evidence.hostFailed,
};

export function resolveVisibility(flags: DesktopFlags, evidence: SurfaceEvidence): Visibility {
    const visible = {} as Record<FlagKey, boolean>;
    for (const key of FLAG_KEYS) {
        const choice = flags[key];
        visible[key] = choice === "on" || (choice === "auto" && (AUTO_CONDITIONS[key]?.(evidence) ?? false));
    }
    return visible;
}

// The view containers each flag puts in the layout. Browser is one pane; the rest are one each.
export const FLAG_CONTAINERS: Readonly<Partial<Record<FlagKey, string>>> = {
    review: CORE_CONTAINERS.review,
    plan: CORE_CONTAINERS.plan,
    files: CORE_CONTAINERS.files,
    output: CORE_CONTAINERS.output,
    browser: CORE_CONTAINERS.browser,
};

export function unavailableContainers(visible: Visibility): ReadonlySet<string> {
    const hidden = new Set<string>();
    for (const [key, container] of Object.entries(FLAG_CONTAINERS)) {
        if (!visible[key as FlagKey]) hidden.add(container);
    }
    return hidden;
}

// The commands each flag offers in menus, the palette and the slash menu.
const FLAG_COMMANDS: Readonly<Partial<Record<FlagKey, readonly string[]>>> = {
    search: [NAVIGATION_COMMANDS.search],
    work: [NAVIGATION_COMMANDS.work],
    customize: [NAVIGATION_COMMANDS.customize],
    devices: [NAVIGATION_COMMANDS.devices],
    tour: [NAVIGATION_COMMANDS.tour],
    coverage: [NAVIGATION_COMMANDS.coverage],
    browser: [...Object.values(PAGE_COMMANDS), BROWSER_HISTORY_COMMAND],
    doctor: [OVERLAY_COMMANDS.doctor.id],
    diagnostics: [OVERLAY_COMMANDS.diagnostics.id],
    failures: [OVERLAY_COMMANDS.failures.id],
    configure: [OVERLAY_COMMANDS.configure.id],
    nudges: [OVERLAY_COMMANDS.nudges.id],
    extensions: [OVERLAY_COMMANDS.extensions.id],
};

// A toggle with no pane to open is an entry point to nothing.
const LOCATION_TOGGLES = {
    rightPane: LAYOUT_COMMANDS.toggleRightPane,
    panel: LAYOUT_COMMANDS.togglePanel,
} as const;

export type ToggleLocation = keyof typeof LOCATION_TOGGLES;

export type EmptyLocations = Readonly<Record<ToggleLocation, boolean>>;

// Without the layout, a location is empty when none of the core panes placed there by default is available.
export function emptyLocations(visible: Visibility): EmptyLocations {
    return {
        rightPane: !visible.review && !visible.plan && !visible.files && !visible.browser,
        panel: !visible.output,
    };
}

export const GATED_COMMANDS: ReadonlySet<string> = new Set([
    ...Object.values(FLAG_COMMANDS).flat(),
    ...Object.values(LOCATION_TOGGLES),
]);

export function hiddenCommands(visible: Visibility, empty: EmptyLocations): ReadonlySet<string> {
    const hidden = new Set<string>();
    for (const key of FLAG_KEYS) {
        if (!visible[key]) for (const id of FLAG_COMMANDS[key] ?? []) hidden.add(id);
    }
    for (const location of Object.keys(LOCATION_TOGGLES) as ToggleLocation[]) {
        if (empty[location]) hidden.add(LOCATION_TOGGLES[location]);
    }
    return hidden;
}

// What the shell shows before the window reports: only parts the file turns on.
export function hiddenCommandsFor(flags: DesktopFlags): ReadonlySet<string> {
    const visible = resolveVisibility(flags, NO_EVIDENCE);
    return hiddenCommands(visible, emptyLocations(visible));
}

const MAX_HIDDEN_IDS = 64;

// The shell takes ids from the window; anything that is not a gated command is dropped.
export function parseHiddenIds(value: unknown): ReadonlySet<string> | undefined {
    if (!Array.isArray(value) || value.length > MAX_HIDDEN_IDS) return undefined;
    const ids = new Set<string>();
    for (const id of value) {
        if (typeof id !== "string") return undefined;
        if (GATED_COMMANDS.has(id)) ids.add(id);
    }
    return ids;
}
