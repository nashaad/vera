import type { CliRenderer, TerminalColors } from "@opentui/core";
import themeCatalog from "../../config/tui-themes.json" with { type: "json" };

export type TuiThemeName =
    | "default"
    | "system"
    | "orng"
    | "palenight"
    | "synthwave"
    | "nightowl"
    | "github";

export interface TuiTheme {
    readonly accent: string;
    readonly text: string;
    readonly muted: string;
    readonly notice: string;
    readonly success: string;
    readonly background: string;
    readonly panel: string;
    readonly element: string;
}

export const VERA_TUI_THEME: TuiTheme = themeCatalog.themes.vera;

// The four palette roles shown as a per-row swatch in the theme picker, so the
// list is made of the themes it offers rather than a generic select dialog.
// "system" is terminal-derived and unknown until applied, so it has no static
// swatch; callers render a neutral placeholder for it.
export function tuiThemeSwatch(name: TuiThemeName): readonly string[] | undefined {
    if (name === "system") {
        return undefined;
    }
    const theme = name === "default" ? VERA_TUI_THEME : themeCatalog.themes[name];
    return [theme.accent, theme.notice, theme.success, theme.text];
}

// Exact dark-mode role colors from OpenCode's MIT-licensed themes.
// Palette detection follows OpenCode's system-theme mechanism (MIT, © 2025
// opencode): ask OpenTUI for the terminal palette and retain Vera's own roles.
export async function resolveTuiTheme(
    renderer: Pick<CliRenderer, "getPalette">,
    name: TuiThemeName = "default",
): Promise<TuiTheme> {
    if (name === "default") {
        return VERA_TUI_THEME;
    }
    if (name === "system") {
        return resolveSystemTuiTheme(renderer);
    }
    return themeCatalog.themes[name];
}

export async function resolveSystemTuiTheme(
    renderer: Pick<CliRenderer, "getPalette">,
): Promise<TuiTheme> {
    try {
        return themeFromTerminal(await renderer.getPalette({ size: 16 }));
    } catch {
        return VERA_TUI_THEME;
    }
}

export function themeFromTerminal(colors: TerminalColors): TuiTheme {
    const background = colors.defaultBackground ?? colors.palette[0];
    const text = colors.defaultForeground ?? colors.palette[7];
    if (background == null || text == null) {
        return VERA_TUI_THEME;
    }

    return {
        accent: paletteColor(colors, 6, VERA_TUI_THEME.accent),
        text,
        muted: mixHex(background, text, 0.55),
        notice: paletteColor(colors, 3, VERA_TUI_THEME.notice),
        success: paletteColor(colors, 2, VERA_TUI_THEME.success),
        background,
        panel: mixHex(background, text, 0.08),
        element: mixHex(background, text, 0.13),
    };
}

function paletteColor(
    colors: TerminalColors,
    index: number,
    fallback: string,
): string {
    return colors.palette[index] ?? fallback;
}

function mixHex(base: string, overlay: string, amount: number): string {
    const baseRgb = parseHex(base);
    const overlayRgb = parseHex(overlay);
    if (baseRgb === undefined || overlayRgb === undefined) {
        return overlay;
    }

    const mixed = baseRgb.map((value, index) => Math.round(
        value + ((overlayRgb[index] ?? value) - value) * amount,
    ));
    return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string): readonly number[] | undefined {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (match?.[1] === undefined) {
        return undefined;
    }
    return [0, 2, 4].map((offset) => Number.parseInt(
        match[1]!.slice(offset, offset + 2),
        16,
    ));
}
