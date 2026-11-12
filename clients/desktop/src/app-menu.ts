import type { MenuItemConstructorOptions } from "electron";

import { THEME_COMMANDS } from "../../ui/src/commands/theme-commands.ts";
import { DEFAULT_THEME, THEME_NAMES, type ThemeName } from "../../ui/src/theme/tokens.ts";
import { LAYOUT_SHORTCUTS } from "./shortcuts.ts";

const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
    dark: "Dark",
    light: "Light",
    "high-contrast": "High contrast",
};

// Menu items only ask the page to run a command; the page owns the layout and the theme.
export function buildMenuTemplate(
    platform: string,
    run: (commandId: string) => void,
    theme: ThemeName = DEFAULT_THEME,
): MenuItemConstructorOptions[] {
    const layoutItems: MenuItemConstructorOptions[] = LAYOUT_SHORTCUTS.map((shortcut) => ({
        id: shortcut.command,
        label: shortcut.label,
        accelerator: shortcut.accelerator,
        click: () => run(shortcut.command),
    }));
    const themeItems: MenuItemConstructorOptions[] = THEME_NAMES.map((name) => ({
        id: THEME_COMMANDS[name],
        label: THEME_LABELS[name],
        type: "radio",
        checked: name === theme,
        click: () => run(THEME_COMMANDS[name]),
    }));
    const view: MenuItemConstructorOptions = {
        label: "View",
        submenu: [
            ...layoutItems,
            { type: "separator" },
            { id: "layout.reset", label: "Reset Layout", click: () => run("layout.reset") },
            { type: "separator" },
            { label: "Theme", submenu: themeItems },
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
        { role: "windowMenu" },
    ];
}
