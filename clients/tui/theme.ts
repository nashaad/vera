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
    | "midnight-blue-ii"
    | "norton-commander"
    | "nc-navy"
    | "windows-31";

export interface TuiThemeHud {
    readonly background?: string;
    readonly border?: string;
    readonly text?: string;
    readonly muted?: string;
    readonly accent?: string;
    readonly notice?: string;
    readonly success?: string;
    readonly auto?: string;
}

export interface TuiTheme {
    readonly accent: string;
    readonly text: string;
    readonly muted: string;
    readonly notice: string;
    readonly danger: string;
    readonly success: string;
    readonly critical: string;
    readonly secondary: string;
    readonly focus: string;
    readonly inactive: string;
    readonly activityTrail: string;
    readonly dangerSurface: string;
    readonly diffAdded: string;
    readonly diffRemoved: string;
    readonly code: string;
    readonly background: string;
    readonly panel: string;
    readonly element: string;
    readonly input: string;
    readonly menu: string;
    readonly chrome: "plain" | "norton";
    readonly selectionText: string;
    readonly hud?: TuiThemeHud;
}

type RequiredTuiThemeRole = Exclude<keyof TuiTheme, "hud">;

export const TUI_THEME_REQUIRED_ROLES = [
    "accent",
    "text",
    "muted",
    "notice",
    "danger",
    "success",
    "critical",
    "secondary",
    "focus",
    "inactive",
    "activityTrail",
    "dangerSurface",
    "diffAdded",
    "diffRemoved",
    "code",
    "background",
    "panel",
    "element",
    "input",
    "menu",
    "chrome",
    "selectionText",
] as const satisfies readonly RequiredTuiThemeRole[];

type MissingRequiredTuiThemeRole = Exclude<
    RequiredTuiThemeRole,
    typeof TUI_THEME_REQUIRED_ROLES[number]
>;
const TUI_THEME_ROLES_ARE_EXHAUSTIVE:
    MissingRequiredTuiThemeRole extends never ? true : never = true;
void TUI_THEME_ROLES_ARE_EXHAUSTIVE;

function catalogTheme(name: keyof typeof themeCatalog.themes): TuiTheme {
    const candidate: Record<string, unknown> = themeCatalog.themes[name];
    for (const role of TUI_THEME_REQUIRED_ROLES) {
        const value = candidate[role];
        if (
            typeof value !== "string"
            || (role === "chrome" && value !== "plain" && value !== "norton")
        ) {
            throw new TypeError(`TUI theme ${name} has no valid ${role} role`);
        }
    }
    return candidate as unknown as TuiTheme;
}

export const VERA_TUI_THEME = catalogTheme("vera");

export function tuiThemeSwatch(name: TuiThemeName): readonly string[] | undefined {
    if (name === "system") {
        return undefined;
    }
    const theme = name === "default" ? VERA_TUI_THEME : themeCatalog.themes[name];
    return [theme.accent, theme.notice, theme.success, theme.text];
}

// Dark-mode role colors adapted from OpenCode's MIT-licensed themes. Palette detection follows OpenCode's system-theme mechanism (MIT, © 2025 opencode): ask OpenTUI for the termin…
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
    return catalogTheme(name);
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
        text: mixHex(background, text, 0.85),
        muted: mixHex(background, text, 0.55),
        notice: paletteColor(colors, 3, VERA_TUI_THEME.notice),
        danger: paletteColor(colors, 1, VERA_TUI_THEME.danger),
        success: paletteColor(colors, 2, VERA_TUI_THEME.success),
        critical: VERA_TUI_THEME.critical,
        secondary: VERA_TUI_THEME.secondary,
        focus: VERA_TUI_THEME.focus,
        inactive: VERA_TUI_THEME.inactive,
        activityTrail: VERA_TUI_THEME.activityTrail,
        dangerSurface: VERA_TUI_THEME.dangerSurface,
        diffAdded: paletteColor(colors, 2, VERA_TUI_THEME.diffAdded),
        diffRemoved: paletteColor(colors, 1, VERA_TUI_THEME.diffRemoved),
        code: paletteColor(colors, 2, VERA_TUI_THEME.code),
        background,
        panel: mixHex(background, text, 0.08),
        element: mixHex(background, text, 0.13),
        input: background,
        menu: mixHex(background, text, 0.08),
        chrome: "plain",
        selectionText: background,
    };
}

export function tuiRecessColor(theme: TuiTheme): string {
    return mixHex(theme.background, "#000000", 0.45);
}

export function tuiHandleColor(theme: TuiTheme): string {
    return mixHex(theme.background, theme.text, 0.07);
}

export function tuiHandleActiveColor(theme: TuiTheme): string {
    return mixHex(theme.background, theme.text, 0.30);
}

/** Quiet semantic grounds for unified diff rows. Keep these derived from the active background so they stay subordinate to syntax highlighting across Vera's dark themes instead of… */
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

export function mixHex(
    base: string,
    overlay: string,
    amount: number,
): string {
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
