import type { MenuItemConstructorOptions } from "electron";

import { importedThemeCommand, THEME_COMMANDS } from "../../ui/src/commands/theme-commands.ts";
import type { DesktopMenuItem } from "../../ui/src/protocol/extensions.ts";
import { DEFAULT_THEME, importedThemeId, THEME_NAMES, type ThemeChoice } from "../../ui/src/theme/tokens.ts";
import { CHAT_COMMANDS } from "../../ui/src/commands/chat-commands.ts";
import { RELOAD_SHORTCUT, type NativeShortcut } from "../../ui/src/commands/keys.ts";
import { NAVIGATION_COMMANDS } from "../../ui/src/commands/navigation-commands.ts";
import { OVERLAY_COMMANDS } from "../../ui/src/commands/overlay-ids.ts";
import { FIND_SHORTCUT, GO_SHORTCUTS, HELP_SHORTCUTS, LAYOUT_SHORTCUTS } from "./shortcuts.ts";
import { THEME_LABELS } from "../../ui/src/theme/registry.ts";

export interface ImportedMenuTheme {
    readonly slug: string;
    readonly name: string;
}

// Drops the items the window has hidden, then any separator left first, last or doubled.
function withoutHidden(items: readonly MenuItemConstructorOptions[], hidden: ReadonlySet<string>): MenuItemConstructorOptions[] {
    const kept: MenuItemConstructorOptions[] = [];
    for (const entry of items) {
        if (entry.id !== undefined && hidden.has(entry.id)) continue;
        if (entry.type === "separator" && (kept.length === 0 || kept[kept.length - 1]?.type === "separator")) continue;
        kept.push(entry);
    }
    while (kept[kept.length - 1]?.type === "separator") kept.pop();
    return kept;
}

// Menu items ask the page to run a command, except Find, which the shell handles; the page owns layout and theme.
// `hidden` names the commands the window has taken out of its menus.
export function buildMenuTemplate(
    platform: string,
    run: (commandId: string) => void,
    theme: ThemeChoice = DEFAULT_THEME,
    imported: readonly ImportedMenuTheme[] = [],
    hidden: ReadonlySet<string> = new Set(),
    // Commands that enabled extensions list in the Theme submenu, after the themes.
    themeCommands: readonly DesktopMenuItem[] = [],
): MenuItemConstructorOptions[] {
    const item = (shortcut: NativeShortcut): MenuItemConstructorOptions => ({
        id: shortcut.command,
        label: shortcut.label,
        accelerator: shortcut.accelerator,
        click: () => run(shortcut.command),
    });
    const plain = (id: string, label: string): MenuItemConstructorOptions => ({ id, label, click: () => run(id) });
    const sheet = (overlay: keyof typeof OVERLAY_COMMANDS, ellipsis = true): MenuItemConstructorOptions =>
        plain(OVERLAY_COMMANDS[overlay].id, `${OVERLAY_COMMANDS[overlay].title}${ellipsis ? "…" : ""}`);
    const layoutItems = LAYOUT_SHORTCUTS.map(item);
    const [newChat, back, forward, search, settings] = GO_SHORTCUTS.map(item);
    const go: MenuItemConstructorOptions = {
        label: "Go",
        submenu: withoutHidden([
            newChat,
            { type: "separator" },
            back,
            forward,
            { type: "separator" },
            search,
            plain(NAVIGATION_COMMANDS.work, "Work"),
            plain(NAVIGATION_COMMANDS.customize, "Plugins"),
            plain(NAVIGATION_COMMANDS.devices, "Devices"),
            settings,
            { type: "separator" },
            plain(NAVIGATION_COMMANDS.tour, "Tour"),
            plain(NAVIGATION_COMMANDS.coverage, "Coverage"),
        ].filter(
            (entry): entry is MenuItemConstructorOptions => entry !== undefined,
        ), hidden),
    };
    const themeItems: MenuItemConstructorOptions[] = THEME_NAMES.map((name) => ({
        id: THEME_COMMANDS[name],
        label: THEME_LABELS[name],
        type: "radio",
        checked: name === theme,
        click: () => run(THEME_COMMANDS[name]),
    }));
    const importedItems: MenuItemConstructorOptions[] = imported.map((entry) => ({
        id: importedThemeCommand(entry.slug),
        label: entry.name.replaceAll("&", "&&"),
        type: "radio",
        checked: importedThemeId(entry.slug) === theme,
        click: () => run(importedThemeCommand(entry.slug)),
    }));
    const [palette, sessions, keys] = HELP_SHORTCUTS.map(item);
    const view: MenuItemConstructorOptions = {
        label: "View",
        submenu: withoutHidden([
            ...[palette, sessions].filter((entry): entry is MenuItemConstructorOptions => entry !== undefined),
            { type: "separator" },
            ...layoutItems,
            sheet("agent"),
            { type: "separator" },
            { id: "layout.reset", label: "Reset Layout", click: () => run("layout.reset") },
            { type: "separator" },
            {
                label: "Theme",
                submenu: [
                    ...themeItems,
                    ...(importedItems.length === 0 ? [] : [{ type: "separator" } as const, ...importedItems]),
                    ...(themeCommands.length === 0 ? [] : [{ type: "separator" } as const, ...themeCommands.map((entry) => plain(entry.command, entry.title))]),
                ],
            },
            sheet("themes"),
            { type: "separator" },
            item(RELOAD_SHORTCUT),
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
        ], hidden),
    };
    const macEditItems: MenuItemConstructorOptions[] = [
        { type: "separator" },
        { label: "Substitutions", submenu: [
            { role: "showSubstitutions" },
            { type: "separator" },
            { role: "toggleSmartQuotes" },
            { role: "toggleSmartDashes" },
            { role: "toggleTextReplacement" },
        ] },
        { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
    ];
    return [
        platform === "darwin"
            ? { role: "appMenu" }
            : { label: "File", submenu: [{ role: "quit" }] },
        {
            label: "Edit",
            submenu: withoutHidden([
                { role: "undo" },
                { role: "redo" },
                { type: "separator" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                ...(platform === "darwin" ? [{ role: "pasteAndMatchStyle" } as const] : []),
                { role: "delete" },
                ...(platform === "darwin" ? [] : [{ type: "separator" } as const]),
                { role: "selectAll" },
                ...(platform === "darwin" ? macEditItems : []),
                { type: "separator" },
                item(FIND_SHORTCUT),
            ], hidden),
        },
        view,
        go,
        { role: "windowMenu" },
        {
            role: "help",
            submenu: withoutHidden([
                plain(CHAT_COMMANDS.help, "New Help Chat"),
                ...(keys === undefined ? [] : [keys]),
                { type: "separator" },
                sheet("diagnostics"),
                sheet("doctor"),
                { type: "separator" },
                sheet("extensions"),
                sheet("configure"),
                sheet("failures"),
                sheet("nudges"),
            ], hidden),
        },
    ];
}
