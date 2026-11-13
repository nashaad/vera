import { baseColor } from "../../../ui/src/theme/imported.ts";
import type { ColorToken, ThemeName } from "../../../ui/src/theme/tokens.ts";

// Tokens Vera draws as grays between the surface and the text. Hues, and badge-text, which pairs with a hue, keep the built-in value.
export const NEUTRAL_TOKENS: readonly ColorToken[] = [
    "surface-sidebar",
    "surface-panel",
    "surface-raised",
    "surface-menu",
    "surface-input",
    "surface-hover",
    "surface-selected",
    "titlebar",
    "tab-active",
    "tab-inactive",
    "border",
    "border-input",
    "text-muted",
    "text-dim",
    "text-disabled",
    "scrollbar",
    "slider-rail",
];

// A theme whose text is itself a mid gray (VS Code's Light+ foreground) would leave these unreadable at Vera's mix factor.
const READABLE_TOKENS: readonly ColorToken[] = ["text-muted", "text-dim"];
const MIN_READABLE_CONTRAST = 4.5;
const READABLE_STEP = 0.02;

export interface NeutralAnchors {
    readonly surface: string;
    readonly text: string;
}

type Rgb = readonly [number, number, number];

function channels(color: string): Rgb {
    const channel = (start: number): number => Number.parseInt(color.slice(start, start + 2), 16);
    return [channel(1), channel(3), channel(5)];
}

function hexOf(rgb: Rgb): string {
    return `#${rgb.map((value) => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

// Where the built-in value of a token sits on the line from its surface (0) to its text (1), fitted across RGB.
// A value past the surface gets a negative factor, such as the white cards of Light.
function mixFactor(type: ThemeName, token: ColorToken): number {
    const surface = channels(baseColor(type, "surface"));
    const text = channels(baseColor(type, "text"));
    const value = channels(baseColor(type, token));
    let along = 0;
    let span = 0;
    for (let index = 0; index < 3; index += 1) {
        const toText = text[index]! - surface[index]!;
        along += (value[index]! - surface[index]!) * toText;
        span += toText * toText;
    }
    if (span === 0) return 0;
    return Math.min(1, Math.max(-1, along / span));
}

function mixAt(surface: Rgb, text: Rgb, factor: number): Rgb {
    const mix = (index: number): number => surface[index]! + factor * (text[index]! - surface[index]!);
    return [mix(0), mix(1), mix(2)];
}

function luminance(rgb: Rgb): number {
    const linear = (value: number): number => {
        const unit = Math.min(255, Math.max(0, Math.round(value))) / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

function contrast(first: Rgb, second: Rgb): number {
    const [low, high] = [luminance(first), luminance(second)].sort((a, b) => a - b);
    return (high! + 0.05) / (low! + 0.05);
}

// The token's color for a theme that does not set it: the same distance from the theme's surface toward its text
// as the built-in theme puts it, so the contrast Vera designed holds on any background. Alpha on the anchors is ignored.
export function deriveNeutral(type: ThemeName, token: ColorToken, anchors: NeutralAnchors): string {
    const surface = channels(anchors.surface);
    const text = channels(anchors.text);
    let factor = mixFactor(type, token);
    if (READABLE_TOKENS.includes(token)) {
        while (factor < 1 && contrast(mixAt(surface, text, factor), surface) < MIN_READABLE_CONTRAST) {
            factor = Math.min(1, factor + READABLE_STEP);
        }
    }
    return hexOf(mixAt(surface, text, factor));
}
