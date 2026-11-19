// What the Help chat's show tool can open. The host checks a target against this list, and each
// client maps an id to its own screen. A target is added here and in every client that shows it.

export type ShowTargetKind = "dialog" | "settings" | "page";

export interface ShowTarget {
    readonly id: string;
    readonly kind: ShowTargetKind;
    // The name the window gives the screen.
    readonly label: string;
    // True when the terminal has a screen that does the same job.
    readonly terminal: boolean;
}

function dialog(id: string, label: string, terminal: boolean): ShowTarget {
    return { id: `dialog.${id}`, kind: "dialog", label, terminal };
}

function settings(id: string, label: string, terminal: boolean): ShowTarget {
    return { id: `settings.${id}`, kind: "settings", label, terminal };
}

function page(id: string, label: string, terminal: boolean): ShowTarget {
    return { id: `page.${id}`, kind: "page", label, terminal };
}

export const SHOW_TARGETS: readonly ShowTarget[] = [
    dialog("palette", "Command Palette", true),
    dialog("sessions", "Go to Session", true),
    dialog("shortcuts", "Keyboard Shortcuts", true),
    dialog("agent", "Choose Agent", true),
    dialog("themes", "Choose Theme", true),
    dialog("extensions", "Extensions", true),
    dialog("diagnostics", "Session Diagnostics", false),
    dialog("doctor", "Check Vera's Health", false),
    dialog("configure", "Configuration Files", true),
    dialog("failures", "Model Failures", false),
    dialog("nudges", "Standing Nudges", true),
    dialog("feedback", "Feedback", false),
    settings("appearance", "Appearance", true),
    settings("agents", "Agents", true),
    settings("approvals", "Approvals", true),
    settings("providers", "Providers", true),
    settings("models", "Models", false),
    settings("workspaces", "Workspaces", false),
    settings("git", "Git & PRs", false),
    settings("devices", "Devices", false),
    settings("keyboard", "Keyboard", true),
    settings("updates", "Updates", false),
    settings("show", "Show", false),
    settings("data", "Data", false),
    page("new-chat", "New Chat", false),
    page("work", "Work", true),
    page("search", "Search", true),
    page("devices", "Devices", false),
    page("customize", "Customize", false),
    page("settings", "Settings", true),
    page("coverage", "Coverage", false),
];

const BY_ID = new Map(SHOW_TARGETS.map((target) => [target.id, target]));

export function findShowTarget(id: unknown): ShowTarget | undefined {
    return typeof id === "string" ? BY_ID.get(id) : undefined;
}

export type ShowSurface = "window" | "terminal";

export function surfaceCanShow(surface: ShowSurface, target: ShowTarget): boolean {
    return surface === "window" || target.terminal;
}
