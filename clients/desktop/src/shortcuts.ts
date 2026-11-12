import { NATIVE_SHORTCUTS } from "../../ui/src/commands/keys.ts";

export { GO_SHORTCUTS, HELP_SHORTCUTS, LAYOUT_SHORTCUTS, SESSION_SHORTCUTS } from "../../ui/src/commands/keys.ts";

export interface ShortcutInput {
    readonly type: string;
    readonly code: string;
    readonly alt: boolean;
    readonly shift: boolean;
    readonly control: boolean;
    readonly meta: boolean;
    readonly isAutoRepeat: boolean;
}

// Matches by physical key: Option+B types a different character on macOS.
export function shortcutCommand(input: ShortcutInput, platform: string): string | undefined {
    if (input.type !== "keyDown" || input.isAutoRepeat) return undefined;
    const modifier = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
    if (!modifier) return undefined;
    return NATIVE_SHORTCUTS.find((shortcut) =>
        shortcut.code === input.code && shortcut.alt === input.alt && shortcut.shift === input.shift)?.command;
}
