import type { MenuItemConstructorOptions } from "electron";

import { importedThemeCommand, THEME_COMMANDS, THEME_IMPORT_COMMAND } from "../../ui/src/commands/theme-commands.ts";
import { DEFAULT_THEME, importedThemeId, THEME_NAMES, type ThemeChoice, type ThemeName } from "../../ui/src/theme/tokens.ts";
import type { NativeShortcut } from "../../ui/src/commands/keys.ts";
import { NAVIGATION_COMMANDS } from "../../ui/src/commands/navigation-commands.ts";
import { OVERLAY_COMMANDS } from "../../ui/src/commands/overlay-ids.ts";
import { GO_SHORTCUTS, HELP_SHORTCUTS, LAYOUT_SHORTCUTS, SESSION_SHORTCUTS } from "./shortcuts.ts";

const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
    dark: "Dark",
    light: "Light",
    "high-contrast": "High contrast",
};

export interface ImportedMenuTheme {
    readonly slug: string;
    readonly name: string;
}

// Menu items only ask the page to run a command; the page owns the layout and the theme.
export function buildMenuTemplate(
    platform: string,
    run: (commandId: string) => void,
    theme: ThemeChoice = DEFAULT_THEME,
    imported: readonly ImportedMenuTheme[] = [],
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
    const [newChat, back, forward, settings] = GO_SHORTCUTS.map(item);
    const go: MenuItemConstructorOptions = {
        label: "Go",
        submenu: [
            newChat,
            { type: "separator" },
            back,
            forward,
            { type: "separator" },
            plain(NAVIGATION_COMMANDS.search, "Search"),
            plain(NAVIGATION_COMMANDS.work, "Work"),
            plain(NAVIGATION_COMMANDS.customize, "Customize"),
            plain(NAVIGATION_COMMANDS.devices, "Devices"),
            settings,
            { type: "separator" },
            plain(NAVIGATION_COMMANDS.tour, "Tour"),
            plain(NAVIGATION_COMMANDS.coverage, "Coverage"),
        ].filter(
            (entry): entry is MenuItemConstructorOptions => entry !== undefined,
        ),
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
        submenu: [
            ...[palette, sessions].filter((entry): entry is MenuItemConstructorOptions => entry !== undefined),
            { type: "separator" },
            ...layoutItems,
            ...SESSION_SHORTCUTS.map(item),
            sheet("agent"),
            { type: "separator" },
            { id: "layout.reset", label: "Reset Layout", click: () => run("layout.reset") },
            { type: "separator" },
            {
                label: "Theme",
                submenu: [
                    ...themeItems,
                    ...(importedItems.length === 0 ? [] : [{ type: "separator" } as const, ...importedItems]),
                    { type: "separator" },
                    plain(THEME_IMPORT_COMMAND, "Import VS Code Theme…"),
                ],
            },
            sheet("themes"),
            { type: "separator" },
            { role: "reload" },
            { role: "forceReload" },
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
        ],
    };
    return [
        platform === "darwin"
            ? { role: "appMenu" }
            : { label: "File", submenu: [{ role: "quit" }] },
        { role: "editMenu" },
        view,
        go,
        { role: "windowMenu" },
        {
            role: "help",
            submenu: [
                ...(keys === undefined ? [] : [keys]),
                { type: "separator" },
                sheet("diagnostics"),
                sheet("doctor"),
                { type: "separator" },
                sheet("extensions"),
                sheet("configure"),
                sheet("failures"),
                sheet("nudges"),
            ],
        },
    ];
}
