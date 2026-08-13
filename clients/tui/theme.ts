import type { CliRenderer, TerminalColors } from "@opentui/core";
import themeCatalog from "../../config/tui-themes.json" with { type: "json" };

export type TuiThemeName =
    | "default"
    | "system"
    | "muted-blue"
    | "orng"
    | "palenight"
    | "synthwave"
    | "nightowl"
    | "github"
    | "midnight-blue"
    | "midnight-blue-ii";

export interface TuiTheme {
    readonly accent: string;
    readonly text: string;
    readonly muted: string;
    readonly notice: string;
    readonly danger: string;
    readonly success: string;
    readonly diffAdded: string;
    readonly diffRemoved: string;
    readonly code: string;
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

// Dark-mode role colors adapted from OpenCode's MIT-licensed themes.
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
        // Pulled off the terminal's foreground rather than taken raw: a white
        // default is brighter than anything a transcript should be read in.
        text: mixHex(background, text, 0.85),
        muted: mixHex(background, text, 0.55),
        notice: paletteColor(colors, 3, VERA_TUI_THEME.notice),
        danger: paletteColor(colors, 1, VERA_TUI_THEME.danger),
        success: paletteColor(colors, 2, VERA_TUI_THEME.success),
        diffAdded: paletteColor(colors, 2, VERA_TUI_THEME.diffAdded),
        diffRemoved: paletteColor(colors, 1, VERA_TUI_THEME.diffRemoved),
        code: paletteColor(colors, 2, VERA_TUI_THEME.code),
        background,
        panel: mixHex(background, text, 0.08),
        element: mixHex(background, text, 0.13),
    };
}

/**
 * A ground that sits under the conversation rather than on top of it, for a
 * region that is beside the transcript instead of part of it. Darker than the
 * background, because a lighter panel reads as a card in front.
 */
export function tuiRecessColor(theme: TuiTheme): string {
    return mixHex(theme.background, "#000000", 0.45);
}

/**
 * The grab strip between transcript and sidebar. Lighter than either side,
 * because the only thing it has to say is that it can be moved.
 */
export function tuiHandleColor(theme: TuiTheme): string {
    return mixHex(theme.background, theme.text, 0.07);
}

/** The strip while it is held. */
export function tuiHandleActiveColor(theme: TuiTheme): string {
    return mixHex(theme.background, theme.text, 0.30);
}

/**
 * Quiet semantic grounds for unified diff rows. Keep these derived from the
 * active background so they stay subordinate to syntax highlighting across
 * Vera's dark themes instead of using OpenTUI's much brighter defaults.
 */
export function tuiDiffBackgroundColors(
    background: string,
    added: string,
    removed: string,
): {
    readonly added: string;
    readonly removed: string;
} {
    return {
        added: mixHex(background, added, 0.26),
        removed: mixHex(background, removed, 0.22),
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
