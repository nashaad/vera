import { resolveThemeChoice, themeFile, type ThemeRoot } from "./apply.ts";
import { DEFAULT_THEME, isThemeChoice, type ThemeChoice, type ValueToken } from "./tokens.ts";

// Appearance choices kept in this window's storage, applied as scaled theme values so every
// rule that reads a token follows them.
export type Scale = "small" | "default" | "large";
export type Density = "compact" | "default" | "comfortable";

export interface Appearance {
    readonly textSize: Scale;
    readonly codeSize: Scale;
    readonly density: Density;
    readonly reduceMotion: boolean;
    // Keeps an approval's full card in the transcript after it is answered.
    readonly pastApprovals: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
    textSize: "default",
    codeSize: "default",
    density: "default",
    reduceMotion: false,
    pastApprovals: false,
};

export const SCALES: readonly Scale[] = ["small", "default", "large"];
export const DENSITIES: readonly Density[] = ["compact", "default", "comfortable"];

const SCALE_FACTOR: Readonly<Record<Scale, number>> = { small: 0.92, default: 1, large: 1.1 };
const DENSITY_FACTOR: Readonly<Record<Density, number>> = { compact: 0.85, default: 1, comfortable: 1.15 };
const TEXT_TOKENS: readonly ValueToken[] = ["font-size", "font-size-label", "font-size-body", "font-size-chat"];
const SPACE_TOKENS: readonly ValueToken[] = ["space", "row-height"];

const MOTION_TOKENS: readonly ValueToken[] = ["motion", "motion-slow", "motion-loop"];

const STORAGE_KEY = "vera.appearance";

type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): AppearanceStorage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

export function readAppearance(storage: AppearanceStorage | undefined = defaultStorage()): Appearance {
    try {
        const raw = storage?.getItem(STORAGE_KEY);
        if (raw === undefined || raw === null) return DEFAULT_APPEARANCE;
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null) return DEFAULT_APPEARANCE;
        const fields = value as Record<string, unknown>;
        return {
            textSize: SCALES.find((scale) => scale === fields.textSize) ?? DEFAULT_APPEARANCE.textSize,
            codeSize: SCALES.find((scale) => scale === fields.codeSize) ?? DEFAULT_APPEARANCE.codeSize,
            density: DENSITIES.find((density) => density === fields.density) ?? DEFAULT_APPEARANCE.density,
            reduceMotion: fields.reduceMotion === true,
            pastApprovals: fields.pastApprovals === true,
        };
    } catch {
        return DEFAULT_APPEARANCE;
    }
}

export function storeAppearance(appearance: Appearance, storage: AppearanceStorage | undefined = defaultStorage()): void {
    try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(appearance));
    } catch {
        // Storage can be unavailable in a sandboxed renderer; the choice still applies until reload.
    }
}

function scaled(value: string, factor: number): string {
    return factor === 1 ? value : `calc(${value} * ${factor})`;
}

// Runs after the theme's own values are set, since applying a theme resets them.
export function applyAppearance(appearance: Appearance, theme: ThemeChoice, root: ThemeRoot = document.documentElement): void {
    const values = themeFile(theme).values;
    for (const token of TEXT_TOKENS) root.style.setProperty(`--vera-${token}`, scaled(values[token], SCALE_FACTOR[appearance.textSize]));
    root.style.setProperty("--vera-font-size-code", scaled(values["font-size-code"], SCALE_FACTOR[appearance.codeSize]));
    for (const token of SPACE_TOKENS) root.style.setProperty(`--vera-${token}`, scaled(values[token], DENSITY_FACTOR[appearance.density]));
    for (const token of MOTION_TOKENS) {
        root.style.setProperty(`--vera-${token}`, appearance.reduceMotion ? scaled(values[token], 0) : values[token]);
    }
    root.setAttribute("data-density", appearance.density);
}

function currentTheme(): ThemeChoice {
    const name = document.documentElement.getAttribute("data-theme") ?? "";
    return isThemeChoice(name) ? resolveThemeChoice(name) : DEFAULT_THEME;
}

const listeners = new Set<() => void>();

// Called after every change made through `changeAppearance`, so a mounted view can follow it.
export function subscribeAppearance(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// A choice from Settings > Appearance: applied over the current theme and remembered.
export function changeAppearance(appearance: Appearance): void {
    applyAppearance(appearance, currentTheme());
    storeAppearance(appearance);
    for (const listener of listeners) listener();
}
