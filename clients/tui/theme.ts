import type { CliRenderer, TerminalColors } from "@opentui/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** "system", a built-in theme, or a theme from the home's tui-themes.json. */
export type TuiThemeName = string;

export interface TuiThemeEntry {
    readonly name: TuiThemeName;
    readonly label: string;
    readonly description: string;
    readonly theme: TuiTheme;
}

// Unknown names are allowed: a saved theme may come from a home file that has since changed.
export function isTuiThemeName(value: unknown): value is TuiThemeName {
    return typeof value === "string" && value.length > 0;
}

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

export const TUI_THEME_HUD_ROLES = [
    "background",
    "border",
    "text",
    "muted",
    "accent",
    "notice",
    "success",
    "auto",
] as const satisfies readonly (keyof TuiThemeHud)[];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** What is wrong with a complete set of theme roles, or undefined when it is usable. */
export function tuiThemeProblem(
    candidate: Readonly<Record<string, unknown>>,
): string | undefined {
    for (const role of TUI_THEME_REQUIRED_ROLES) {
        const value = candidate[role];
        if (value === undefined) {
            return `${role} is missing`;
        }
        if (role === "chrome") {
            if (value !== "plain" && value !== "norton") {
                return `chrome must be "plain" or "norton"`;
            }
        } else if (typeof value !== "string" || !HEX_COLOR.test(value)) {
            return `${role} must be a color like #A1B2C3`;
        }
    }
    const hud = candidate["hud"];
    if (hud === undefined) {
        return undefined;
    }
    if (typeof hud !== "object" || hud === null || Array.isArray(hud)) {
        return "hud must be an object";
    }
    for (const [role, value] of Object.entries(hud)) {
        if (!(TUI_THEME_HUD_ROLES as readonly string[]).includes(role)) {
            return `hud has no ${role} role`;
        }
        if (typeof value !== "string" || !HEX_COLOR.test(value)) {
            return `hud.${role} must be a color like #A1B2C3`;
        }
    }
    return undefined;
}

const ENTRY_FIELDS: readonly string[] = ["label", "description", "extends", "hud", ...TUI_THEME_REQUIRED_ROLES];

/**
 * One catalog entry, or what is wrong with it. `extends` resolves against `known`,
 * which holds only entries defined before this one, so a chain cannot loop.
 */
export function parseTuiThemeEntry(
    name: string,
    value: unknown,
    known: readonly TuiThemeEntry[],
): TuiThemeEntry | string {
    if (name === "system") {
        return `"system" is reserved for terminal colors`;
    }
    if (name === FALLBACK_TUI_THEME_NAME) {
        return `"${FALLBACK_TUI_THEME_NAME}" is the fallback theme and cannot be replaced`;
    }
    if (!isRecord(value)) {
        return "expected an object";
    }
    const unknownField = Object.keys(value).find((key) => !ENTRY_FIELDS.includes(key));
    if (unknownField !== undefined) {
        return `unknown field "${unknownField}"`;
    }
    const { label, description, extends: base, ...roles } = value;
    if (label !== undefined && typeof label !== "string") {
        return "label must be text";
    }
    if (description !== undefined && typeof description !== "string") {
        return "description must be text";
    }
    let inherited: TuiTheme | undefined;
    if (base !== undefined) {
        if (typeof base !== "string") {
            return "extends must be a theme name";
        }
        inherited = known.find((entry) => entry.name === base)?.theme;
        if (inherited === undefined) {
            return `extends unknown theme "${base}"`;
        }
    }
    const merged: Record<string, unknown> = { ...inherited, ...roles };
    if (inherited?.hud !== undefined && isRecord(roles["hud"])) {
        merged["hud"] = { ...inherited.hud, ...roles["hud"] };
    }
    const problem = tuiThemeProblem(merged);
    if (problem !== undefined) {
        return problem;
    }
    return {
        name,
        label: label ?? name,
        description: description ?? "",
        theme: merged as unknown as TuiTheme,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const FALLBACK_TUI_THEME_NAME = "orng";

// Lives in code, not config/tui-themes.json, so no edit to a themes file can break it.
export const FALLBACK_TUI_THEME: TuiTheme = Object.freeze({
    accent: "#EC5B2B",
    text: "#c6c6c6",
    muted: "#808080",
    notice: "#E8A33D",
    danger: "#FF5F56",
    success: "#8CC265",
    critical: "#ff3b30",
    secondary: "#c586c0",
    focus: "#22c55e",
    inactive: "#4b5563",
    activityTrail: "#B8B6D9",
    dangerSurface: "#210b0b",
    diffAdded: "#2F8F46",
    diffRemoved: "#B94A48",
    code: "#6ba1e6",
    background: "#111111",
    panel: "#181818",
    element: "#222222",
    input: "#111111",
    menu: "#181818",
    chrome: "plain",
    selectionText: "#111111",
});

const FALLBACK_TUI_THEME_ENTRY: TuiThemeEntry = {
    name: FALLBACK_TUI_THEME_NAME,
    label: "Orng",
    description: "warm orange on charcoal",
    theme: FALLBACK_TUI_THEME,
};

interface BuiltInTuiThemes {
    readonly entries: readonly TuiThemeEntry[];
    readonly problems: readonly string[];
}

const BUILT_IN_TUI_THEMES_PATH = fileURLToPath(
    new URL("../../config/tui-themes.json", import.meta.url),
);

/** An unreadable or invalid file yields Orng alone plus a problem, never a throw. */
export function loadBuiltInTuiThemes(path = BUILT_IN_TUI_THEMES_PATH): BuiltInTuiThemes {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return parseBuiltInTuiThemes({}, path, [`${path} could not be loaded: ${reason}`]);
    }
    const themes = isRecord(raw) ? raw["themes"] : undefined;
    if (!isRecord(themes)) {
        return parseBuiltInTuiThemes({}, path, [`${path}: expected {"themes": {...}}`]);
    }
    return parseBuiltInTuiThemes(themes, path);
}

/** A broken built-in is left out with a problem, like a broken home theme. Orng follows the default. */
export function parseBuiltInTuiThemes(
    themes: Readonly<Record<string, unknown>>,
    source: string,
    fileProblems: readonly string[] = [],
): BuiltInTuiThemes {
    const entries: TuiThemeEntry[] = [];
    const problems: string[] = [...fileProblems];
    for (const [name, value] of Object.entries(themes)) {
        const parsed = parseTuiThemeEntry(name, value, [FALLBACK_TUI_THEME_ENTRY, ...entries]);
        if (typeof parsed === "string") {
            problems.push(`${source}: theme "${name}" skipped: ${parsed}`);
            continue;
        }
        entries.push(parsed);
    }
    const defaultIndex = entries.findIndex((entry) => entry.name === "default");
    entries.splice(defaultIndex + 1, 0, FALLBACK_TUI_THEME_ENTRY);
    return { entries, problems };
}

const builtIns = loadBuiltInTuiThemes();

/** Built-in themes in picker order: config/tui-themes.json plus the fallback. */
export const BUILT_IN_TUI_THEMES: readonly TuiThemeEntry[] = builtIns.entries;
export const BUILT_IN_TUI_THEME_PROBLEMS: readonly string[] = builtIns.problems;

export const VERA_TUI_THEME: TuiTheme = BUILT_IN_TUI_THEMES
    .find((entry) => entry.name === "default")?.theme ?? FALLBACK_TUI_THEME;

// Dark-mode role colors adapted from OpenCode's MIT-licensed themes. Palette detection follows OpenCode's system-theme mechanism (MIT, © 2025 opencode): ask OpenTUI for the.
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

/** Quiet semantic grounds for unified diff rows. Keep these derived from the active background so they stay subordinate to syntax highlighting across Vera's dark themes instead. */
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
