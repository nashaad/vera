import { findShowTarget } from "../../../../src/help/show-targets.ts";
import { requestSettingsSection } from "../pages/settings/requestedSection.ts";
import { NAVIGATION_COMMANDS } from "./navigation-commands.ts";
import { OVERLAY_COMMANDS, type Overlay } from "./overlay-ids.ts";

const PAGE_COMMANDS: Readonly<Record<string, string>> = {
    "new-chat": NAVIGATION_COMMANDS.newChat,
    work: NAVIGATION_COMMANDS.work,
    search: NAVIGATION_COMMANDS.search,
    devices: NAVIGATION_COMMANDS.devices,
    customize: NAVIGATION_COMMANDS.customize,
    settings: NAVIGATION_COMMANDS.settings,
    coverage: NAVIGATION_COMMANDS.coverage,
};

function overlayCommand(name: string): string | undefined {
    return Object.hasOwn(OVERLAY_COMMANDS, name) ? OVERLAY_COMMANDS[name as Overlay].id : undefined;
}

// The command that opens a screen the host named, or undefined for an id the window does not know.
export function showCommand(id: string): string | undefined {
    const target = findShowTarget(id);
    if (target === undefined) return undefined;
    const name = target.id.slice(target.kind.length + 1);
    if (target.kind === "dialog") return overlayCommand(name);
    if (target.kind === "page") return PAGE_COMMANDS[name];
    return NAVIGATION_COMMANDS.settings;
}

// Opens the screen. A Settings section is chosen after the page opens, through the requested-section store.
export function showTarget(id: string, run: (command: string) => void): boolean {
    const command = showCommand(id);
    if (command === undefined) return false;
    const target = findShowTarget(id);
    if (target?.kind === "settings") requestSettingsSection(target.id.slice("settings.".length));
    run(command);
    return true;
}
