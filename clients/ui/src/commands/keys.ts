// Every key the desktop answers, in one table: the shell binds the native ones, and the
// shortcuts sheet and Settings > Keyboard list all of them.

export interface NativeShortcut {
    readonly command: string;
    readonly label: string;
    // Electron accelerator syntax, also used to draw the key on each platform.
    readonly accelerator: string;
    // The physical key, as KeyboardEvent.code names it.
    readonly code: string;
    readonly alt: boolean;
    readonly shift: boolean;
}

export const LAYOUT_SHORTCUTS = [
    { command: "layout.toggleSidebar", label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", code: "KeyB", alt: false, shift: false },
    { command: "layout.toggleRightPane", label: "Toggle Right Pane", accelerator: "CmdOrCtrl+Alt+B", code: "KeyB", alt: true, shift: false },
    { command: "layout.togglePanel", label: "Toggle Panel", accelerator: "CmdOrCtrl+J", code: "KeyJ", alt: false, shift: false },
] as const satisfies readonly NativeShortcut[];

export const GO_SHORTCUTS = [
    { command: "go.newChat", label: "New Chat", accelerator: "CmdOrCtrl+N", code: "KeyN", alt: false, shift: false },
    { command: "go.back", label: "Back", accelerator: "CmdOrCtrl+[", code: "BracketLeft", alt: false, shift: false },
    { command: "go.forward", label: "Forward", accelerator: "CmdOrCtrl+]", code: "BracketRight", alt: false, shift: false },
    { command: "go.settings", label: "Settings", accelerator: "CmdOrCtrl+,", code: "Comma", alt: false, shift: false },
] as const satisfies readonly NativeShortcut[];

export const SESSION_SHORTCUTS = [
    { command: "session.cycleLayout", label: "Cycle Agent Panes", accelerator: "CmdOrCtrl+Alt+A", code: "KeyA", alt: true, shift: false },
] as const satisfies readonly NativeShortcut[];

export const HELP_SHORTCUTS = [
    { command: "palette.commands", label: "Command Palette…", accelerator: "CmdOrCtrl+K", code: "KeyK", alt: false, shift: false },
    { command: "palette.sessions", label: "Go to Session…", accelerator: "CmdOrCtrl+P", code: "KeyP", alt: false, shift: false },
    { command: "help.shortcuts", label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", code: "Slash", alt: false, shift: false },
] as const satisfies readonly NativeShortcut[];

// Bound in the shell with no menu item of their own.
export const EXTRA_SHORTCUTS = [
    { command: "palette.commands", label: "Command Palette…", accelerator: "CmdOrCtrl+Shift+P", code: "KeyP", alt: false, shift: true },
] as const satisfies readonly NativeShortcut[];

export const NATIVE_SHORTCUTS: readonly NativeShortcut[] = [
    ...LAYOUT_SHORTCUTS,
    ...GO_SHORTCUTS,
    ...SESSION_SHORTCUTS,
    ...HELP_SHORTCUTS,
    ...EXTRA_SHORTCUTS,
];

// Keys a part of the page answers while it has focus; the shell does not bind them.
export interface PageKey {
    readonly keys: string;
    readonly label: string;
    readonly where: string;
}

export const PAGE_KEYS: readonly PageKey[] = [
    { keys: "Enter", label: "Send the message", where: "Composer" },
    { keys: "Shift+Enter", label: "New line", where: "Composer" },
    { keys: "Enter", label: "Stop the turn, or send the queue, when the composer is empty", where: "Composer" },
    { keys: "Escape", label: "Send the next queued message now", where: "Composer" },
    { keys: "ArrowUp", label: "Take back a held message to edit", where: "Composer" },
    { keys: "1 2 4", label: "Allow once, allow similar, always allow", where: "Approval card" },
    { keys: "3 or Escape", label: "Deny", where: "Approval card" },
    { keys: "1 to 9", label: "Pick an answer", where: "Question card" },
    { keys: "1 to 9", label: "Pick a shortlisted model", where: "Model menu" },
    { keys: "ArrowUp ArrowDown", label: "Move through a list", where: "Menus and lists" },
    { keys: "Escape", label: "Close", where: "Sheets and menus" },
];

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
    CmdOrCtrl: "⌘",
    Alt: "⌥",
    Shift: "⇧",
    Ctrl: "⌃",
};

const OTHER_NAMES: Readonly<Record<string, string>> = {
    CmdOrCtrl: "Ctrl",
    Alt: "Alt",
    Shift: "Shift",
    Ctrl: "Ctrl",
};

// The keys of an accelerator as a person reads them: ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere.
export function acceleratorKeys(accelerator: string, platform: string): readonly string[] {
    const names = platform === "darwin" ? MAC_SYMBOLS : OTHER_NAMES;
    const parts = accelerator.split("+").map((part) => names[part] ?? part);
    if (platform !== "darwin") return parts;
    // macOS reads Shift before Command, as its menus draw them.
    return [...parts].sort((left, right) => macOrder(left) - macOrder(right));
}

function macOrder(symbol: string): number {
    const order = ["⌃", "⌥", "⇧", "⌘"].indexOf(symbol);
    return order === -1 ? 4 : order;
}

export interface ShortcutRow {
    readonly label: string;
    // Each chord is one way to press it, as key caps; more than one chord means alternatives.
    readonly chords: readonly (readonly string[])[];
}

export interface ShortcutGroup {
    readonly title: string;
    readonly rows: readonly ShortcutRow[];
}

const ARROWS: Readonly<Record<string, string>> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

function nativeRows(shortcuts: readonly NativeShortcut[], platform: string): readonly ShortcutRow[] {
    return shortcuts.map((shortcut) => ({
        label: shortcut.label.replace(/…$/, ""),
        chords: NATIVE_SHORTCUTS
            .filter((other) => other.command === shortcut.command)
            .map((other) => acceleratorKeys(other.accelerator, platform)),
    }));
}

// Every key this window answers, grouped for the shortcuts sheet and Settings > Keyboard.
export function shortcutGroups(platform: string): readonly ShortcutGroup[] {
    const pageRows = new Map<string, ShortcutRow[]>();
    for (const key of PAGE_KEYS) {
        const caps = key.keys.split(" ").map((part) => ARROWS[part] ?? part).join(" ");
        const rows = pageRows.get(key.where) ?? [];
        rows.push({ label: key.label, chords: [[caps]] });
        pageRows.set(key.where, rows);
    }
    return [
        { title: "Window", rows: nativeRows(LAYOUT_SHORTCUTS, platform) },
        { title: "Go", rows: nativeRows(GO_SHORTCUTS, platform) },
        { title: "Session", rows: nativeRows(SESSION_SHORTCUTS, platform) },
        { title: "Help", rows: nativeRows(HELP_SHORTCUTS, platform) },
        ...[...pageRows].map(([title, rows]) => ({ title, rows })),
    ];
}

// Every word of the query must appear in a row's label. Groups left with no rows are dropped.
export function filterShortcutGroups(groups: readonly ShortcutGroup[], query: string): readonly ShortcutGroup[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) return groups;
    const result: ShortcutGroup[] = [];
    for (const group of groups) {
        const rows = group.rows.filter((row) => matchesEveryWord(row, words));
        if (rows.length > 0) result.push({ title: group.title, rows });
    }
    return result;
}

function matchesEveryWord(row: ShortcutRow, words: readonly string[]): boolean {
    const label = row.label.toLowerCase();
    return words.every((word) => label.includes(word));
}
