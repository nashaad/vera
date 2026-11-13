import { baseColor, shadowFor } from "../../../ui/src/theme/imported.ts";
import type { ColorToken, ThemeName } from "../../../ui/src/theme/tokens.ts";
import { COLOR_TOKENS } from "../../../ui/src/theme/tokens.ts";
import { deriveNeutral, NEUTRAL_TOKENS, type NeutralAnchors } from "./neutral-colors.ts";
import { brightness, parseColor } from "./vscode-color.ts";

type MappedToken = Exclude<ColorToken, "text-dim" | "menu-check" | "slider-value" | "slider-rail" | "slider-fill" | "slider-stop" | "slider-knob">;

// Each Vera token takes the first VS Code color in its row that the theme sets.
export const COLOR_ROWS: Readonly<Record<MappedToken, readonly string[]>> = {
    surface: ["editor.background"],
    "surface-sidebar": ["sideBar.background"],
    "surface-panel": ["panel.background", "sideBar.background"],
    "surface-raised": ["editorWidget.background"],
    "surface-menu": ["menu.background", "quickInput.background"],
    "surface-input": ["input.background"],
    "surface-hover": ["list.hoverBackground"],
    "surface-selected": ["list.activeSelectionBackground"],
    "surface-code": ["textCodeBlock.background", "editor.background"],
    titlebar: ["titleBar.activeBackground"],
    "tab-active": ["tab.activeBackground"],
    "tab-inactive": ["tab.inactiveBackground"],
    border: ["panel.border", "sideBar.border", "contrastBorder"],
    "border-input": ["input.border"],
    focus: ["focusBorder"],
    text: ["foreground", "editor.foreground"],
    "text-muted": ["descriptionForeground"],
    "text-disabled": ["disabledForeground"],
    link: ["textLink.foreground"],
    accent: ["button.background"],
    "accent-text": ["button.foreground"],
    badge: ["badge.background"],
    "badge-text": ["badge.foreground"],
    danger: ["errorForeground", "editorError.foreground"],
    warning: ["editorWarning.foreground"],
    success: ["terminal.ansiGreen"],
    "diff-added": ["diffEditor.insertedTextBackground"],
    "diff-removed": ["diffEditor.removedTextBackground"],
    selection: ["editor.selectionBackground"],
    scrollbar: ["scrollbarSlider.background"],
};

const SHADOW_KEY = "widget.shadow";

// Vera draws these as text colors and as a light tint, so VS Code's translucent fill is read as its solid hue.
const SOLID_TOKENS: readonly ColorToken[] = ["diff-added", "diff-removed"];

export interface MappedColors {
    readonly colors: Record<ColorToken, string>;
    readonly shadow: string | undefined;
    // How many of the theme's colors Vera used. Zero means the file is not a color theme Vera can read.
    readonly used: number;
}

export function classifyType(
    declared: unknown,
    uiTheme: unknown,
    colors: Readonly<Record<string, unknown>>,
): ThemeName {
    const fromDeclared = typeFromName(declared);
    if (fromDeclared !== undefined) return fromDeclared;
    const fromUi = typeFromName(uiTheme);
    if (fromUi !== undefined) return fromUi;
    const background = parseColor(colors["editor.background"]);
    if (background === undefined) return "dark";
    return brightness(background) >= 0.5 ? "light" : "dark";
}

function typeFromName(value: unknown): ThemeName | undefined {
    if (typeof value !== "string") return undefined;
    switch (value.trim().toLowerCase()) {
        case "dark":
        case "vs-dark":
            return "dark";
        case "light":
        case "vs":
            return "light";
        case "hc":
        case "hcdark":
        case "hc-black":
            return "high-contrast";
        case "hclight":
        case "hc-light":
            return "light";
        default:
            return undefined;
    }
}

export function mapColors(colors: Readonly<Record<string, unknown>>, type: ThemeName): MappedColors {
    const mapped = {} as Record<ColorToken, string>;
    const anchors = neutralAnchors(colors);
    let used = 0;
    for (const token of COLOR_TOKENS) {
        const row = token in COLOR_ROWS ? COLOR_ROWS[token as MappedToken] : [];
        const found = firstColor(colors, row);
        if (found === undefined) {
            const derives = anchors !== undefined && NEUTRAL_TOKENS.includes(token);
            mapped[token] = derives ? deriveNeutral(type, token, anchors) : baseColor(type, token);
            continue;
        }
        used += 1;
        mapped[token] = SOLID_TOKENS.includes(token) ? withoutAlpha(found) : found;
    }
    const shadowColor = parseColor(colors[SHADOW_KEY]);
    if (shadowColor !== undefined) used += 1;
    return { colors: mapped, shadow: shadowColor === undefined ? undefined : shadowFor(type, shadowColor), used };
}

// A neutral the theme leaves out is worked out from its own surface and text; without both, the built-in value stands.
function neutralAnchors(colors: Readonly<Record<string, unknown>>): NeutralAnchors | undefined {
    const surface = firstColor(colors, COLOR_ROWS.surface);
    const text = firstColor(colors, COLOR_ROWS.text);
    return surface === undefined || text === undefined ? undefined : { surface, text };
}

function firstColor(colors: Readonly<Record<string, unknown>>, row: readonly string[]): string | undefined {
    for (const key of row) {
        const color = parseColor(colors[key]);
        if (color !== undefined) return color;
    }
    return undefined;
}

// A diff fill is drawn behind text; VS Code's translucent fills would show the surface through them.
function withoutAlpha(color: string): string {
    return color.slice(0, 7);
}
