import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { NAVIGATION_COMMANDS } from "../commands/navigation-commands.ts";
import { SESSION_COMMANDS } from "../commands/session-commands.ts";

const KEYS: Readonly<Record<string, { readonly key: string; readonly alt: boolean }>> = {
    [LAYOUT_COMMANDS.toggleSidebar]: { key: "B", alt: false },
    [LAYOUT_COMMANDS.toggleRightPane]: { key: "B", alt: true },
    [LAYOUT_COMMANDS.togglePanel]: { key: "J", alt: false },
    [NAVIGATION_COMMANDS.newChat]: { key: "N", alt: false },
    [NAVIGATION_COMMANDS.back]: { key: "[", alt: false },
    [NAVIGATION_COMMANDS.forward]: { key: "]", alt: false },
    [NAVIGATION_COMMANDS.settings]: { key: ",", alt: false },
    [SESSION_COMMANDS.cycleLayout]: { key: "A", alt: true },
};

// The keys of a command's direct binding, spelled for the platform; empty when it has none.
export function shortcutKeys(command: string, platform: string): readonly string[] {
    const binding = KEYS[command];
    if (binding === undefined) return [];
    if (platform === "darwin") return binding.alt ? ["⌥", "⌘", binding.key] : ["⌘", binding.key];
    return binding.alt ? ["Ctrl", "Alt", binding.key] : ["Ctrl", binding.key];
}

export function shortcutLabel(command: string, platform: string): string {
    return shortcutKeys(command, platform).join(platform === "darwin" ? "" : "+");
}
