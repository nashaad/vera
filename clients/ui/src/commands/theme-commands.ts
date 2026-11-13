import type { ImportedThemeSummary } from "../theme/imported.ts";
import { IMPORTED_THEME_PREFIX, importedThemeId, isThemeName, type ThemeChoice, type ThemeName } from "../theme/tokens.ts";
import type { CommandRegistry } from "./registry.ts";

// One command per theme: a native menu item can only name a command, not pass arguments.
export const THEME_COMMANDS: Readonly<Record<ThemeName, string>> = {
    dark: "theme.dark",
    light: "theme.light",
    "high-contrast": "theme.highContrast",
};

export const THEME_IMPORT_COMMAND = "theme.import";

const THEME_TITLES: Readonly<Record<ThemeName, string>> = {
    dark: "Theme: Dark",
    light: "Theme: Light",
    "high-contrast": "Theme: High Contrast",
};

export function importedThemeCommand(slug: string): string {
    return `theme.imported.${slug}`;
}

// The command that switches to a theme, for a menu or a select that can only run commands.
export function themeCommandId(choice: ThemeChoice): string {
    if (isThemeName(choice)) return THEME_COMMANDS[choice];
    return importedThemeCommand(choice.slice(IMPORTED_THEME_PREFIX.length));
}

export function registerThemeCommands(
    registry: CommandRegistry,
    apply: (choice: ThemeChoice) => void,
    imported: readonly ImportedThemeSummary[] = [],
    importTheme?: () => void,
): () => void {
    const disposers = (Object.keys(THEME_COMMANDS) as ThemeName[]).map((name) => registry.register({
        id: THEME_COMMANDS[name],
        title: THEME_TITLES[name],
        run: () => apply(name),
    }));
    for (const theme of imported) {
        disposers.push(registry.register({
            id: importedThemeCommand(theme.slug),
            title: `Theme: ${theme.name}`,
            run: () => apply(importedThemeId(theme.slug)),
        }));
    }
    if (importTheme !== undefined) {
        disposers.push(registry.register({ id: THEME_IMPORT_COMMAND, title: "Theme: Import VS Code Theme…", run: importTheme }));
    }
    return () => disposers.forEach((dispose) => dispose());
}
