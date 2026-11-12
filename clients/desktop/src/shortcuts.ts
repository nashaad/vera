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

export const GO_SHORTCUTS = [
    { command: "go.newChat", label: "New Chat", accelerator: "CmdOrCtrl+N", code: "KeyN", alt: false },
    { command: "go.back", label: "Back", accelerator: "CmdOrCtrl+[", code: "BracketLeft", alt: false },
    { command: "go.forward", label: "Forward", accelerator: "CmdOrCtrl+]", code: "BracketRight", alt: false },
    { command: "go.settings", label: "Settings", accelerator: "CmdOrCtrl+,", code: "Comma", alt: false },
] as const;

const SHORTCUTS = [...LAYOUT_SHORTCUTS, ...GO_SHORTCUTS];

// Matches by physical key: Option+B types a different character on macOS.
export function shortcutCommand(input: ShortcutInput, platform: string): string | undefined {
    if (input.type !== "keyDown" || input.isAutoRepeat || input.shift) return undefined;
    const modifier = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
    if (!modifier) return undefined;
    return SHORTCUTS.find((shortcut) => shortcut.code === input.code && shortcut.alt === input.alt)?.command;
}
