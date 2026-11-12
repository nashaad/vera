import type { ThemeName } from "../theme/tokens.ts";
import type { CommandRegistry } from "./registry.ts";

// One command per theme: a native menu item can only name a command, not pass arguments.
export const THEME_COMMANDS: Readonly<Record<ThemeName, string>> = {
    dark: "theme.dark",
    light: "theme.light",
    "high-contrast": "theme.highContrast",
};

const THEME_TITLES: Readonly<Record<ThemeName, string>> = {
    dark: "Theme: Dark",
    light: "Theme: Light",
    "high-contrast": "Theme: High Contrast",
};

export function registerThemeCommands(
    registry: CommandRegistry,
    apply: (name: ThemeName) => void,
): () => void {
    const disposers = (Object.keys(THEME_COMMANDS) as ThemeName[]).map((name) => registry.register({
        id: THEME_COMMANDS[name],
        title: THEME_TITLES[name],
        run: () => apply(name),
    }));
    return () => disposers.forEach((dispose) => dispose());
}
