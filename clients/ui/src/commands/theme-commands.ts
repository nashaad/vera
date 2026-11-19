import type { ImportedThemeSummary } from "../theme/imported.ts";
import { IMPORTED_THEME_PREFIX, importedThemeId, isThemeName, type ThemeChoice } from "../theme/tokens.ts";
import { builtinRecord, THEME_LABELS, THEME_NAMES } from "../theme/registry.ts";
import type { CommandRegistry } from "./registry.ts";

// One command per theme: a native menu item can only name a command, not pass arguments.
export const THEME_COMMANDS = builtinRecord((theme) => theme.name === "high-contrast" ? "theme.highContrast" : `theme.${theme.name}`);

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
): () => void {
    const disposers = THEME_NAMES.map((name) => {
        const label = name === "high-contrast" ? "High Contrast" : THEME_LABELS[name];
        return registry.register({
            id: THEME_COMMANDS[name],
            title: `Theme: ${label}`,
            paletteSearchOnly: true,
            paletteSearchText: label,
            run: () => apply(name),
        });
    });
    for (const theme of imported) {
        disposers.push(registry.register({
            id: importedThemeCommand(theme.slug),
            title: `Theme: ${theme.name}`,
            paletteSearchOnly: true,
            paletteSearchText: theme.name,
            run: () => apply(importedThemeId(theme.slug)),
        }));
    }
    return () => disposers.forEach((dispose) => dispose());
}
