export interface ShortcutInput {
    readonly type: string;
    readonly code: string;
    readonly alt: boolean;
    readonly shift: boolean;
    readonly control: boolean;
    readonly meta: boolean;
    readonly isAutoRepeat: boolean;
}

export const LAYOUT_SHORTCUTS = [
    { command: "layout.toggleSidebar", label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", code: "KeyB", alt: false },
    { command: "layout.toggleRightPane", label: "Toggle Right Pane", accelerator: "CmdOrCtrl+Alt+B", code: "KeyB", alt: true },
    { command: "layout.togglePanel", label: "Toggle Panel", accelerator: "CmdOrCtrl+J", code: "KeyJ", alt: false },
] as const;

// Matches by physical key: Option+B types a different character on macOS.
export function shortcutCommand(input: ShortcutInput, platform: string): string | undefined {
    if (input.type !== "keyDown" || input.isAutoRepeat || input.shift) return undefined;
    const modifier = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
    if (!modifier) return undefined;
    return LAYOUT_SHORTCUTS.find((shortcut) => shortcut.code === input.code && shortcut.alt === input.alt)?.command;
}
