import { activeThemeType, VERA_DIFF_THEME } from "./pierreTheme.ts";

export type DiffStyle = "unified" | "split";
export type OverflowMode = "wrap" | "scroll";
export type HunkSeparatorMode = "line-info" | "line-info-basic" | "simple";
export type DiffIndicatorMode = "bars" | "none";

export const MAX_LINE_DIFF_LENGTH = 512;
export const TOKENIZE_MAX_LINE_LENGTH = 1000;

// Pierre's default gutter button carries a negative inline margin that lands in
// the code column. Keep it inside the number column and style it with Vera's tokens.
const GUTTER_UTILITY_CSS = `
[data-gutter-utility-slot] {
    align-items: center;
}
[data-utility-button] {
    width: calc(var(--vera-space) * 4);
    height: calc(var(--vera-space) * 4);
    margin-right: 0;
    padding: 0;
    box-sizing: border-box;
    border: thin solid var(--vera-border);
    border-radius: 50%;
    background: var(--vera-surface-raised);
    color: var(--vera-text-muted);
}
[data-utility-button]:hover {
    background: var(--vera-surface-hover);
    color: var(--vera-text);
}
[data-utility-button] svg {
    width: calc(var(--vera-font-size-code) * 0.75);
    height: calc(var(--vera-font-size-code) * 0.75);
}
[data-line-annotation] {
    min-width: 0;
}
`;

export interface VeraDiffOptions {
    readonly theme: string;
    readonly themeType: "light" | "dark";
    readonly diffStyle: DiffStyle;
    readonly overflow: OverflowMode;
    readonly disableFileHeader: boolean;
    readonly hunkSeparators: HunkSeparatorMode;
    readonly lineDiffType: "word-alt";
    readonly maxLineDiffLength: number;
    readonly tokenizeMaxLineLength: number;
    readonly expandUnchanged: boolean;
    readonly diffIndicators: DiffIndicatorMode;
    readonly lineHoverHighlight: "both";
    readonly enableLineSelection: boolean;
    readonly enableGutterUtility: boolean;
    readonly unsafeCSS: string;
}

export function diffOptions(
    diffStyle: DiffStyle,
    overflow: OverflowMode,
    hunkSeparators: HunkSeparatorMode = "line-info-basic",
    diffIndicators: DiffIndicatorMode = "bars",
): VeraDiffOptions {
    return {
        theme: VERA_DIFF_THEME,
        themeType: activeThemeType(),
        diffStyle,
        overflow,
        disableFileHeader: true,
        hunkSeparators,
        lineDiffType: "word-alt",
        maxLineDiffLength: MAX_LINE_DIFF_LENGTH,
        tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
        expandUnchanged: false,
        diffIndicators,
        lineHoverHighlight: "both",
        enableLineSelection: true,
        enableGutterUtility: true,
        unsafeCSS: GUTTER_UTILITY_CSS,
    };
}
