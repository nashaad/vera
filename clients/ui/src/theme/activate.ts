import type { DesktopBridge } from "../protocol/bridge.ts";
import { applyTheme, resolveThemeChoice, type ThemeRoot } from "./apply.ts";
import { applyAppearance, readAppearance, type Appearance } from "./preferences.ts";
import { storeTheme } from "./storage.ts";
import type { ThemeChoice } from "./tokens.ts";

export interface ThemeEnvironment {
    readonly root?: ThemeRoot;
    readonly bridge?: Pick<DesktopBridge, "setWindowBackground" | "setTheme">;
    readonly surface?: () => string;
    readonly appearance?: Appearance;
}

function pageSurface(): string {
    return getComputedStyle(document.documentElement).getPropertyValue("--vera-surface");
}

// Applies a theme, then reports the resolved surface color so the native window
// behind the page matches it; the page paints a frame late during a resize.
// The theme name goes with it so the View menu can check the current theme.
export function activateTheme(choice: ThemeChoice, environment: ThemeEnvironment = {}): void {
    const root = environment.root ?? document.documentElement;
    const name = applyTheme(choice, root);
    applyAppearance(environment.appearance ?? readAppearance(), name, root);
    const bridge = environment.bridge ?? globalThis.window?.veraDesktop;
    if (bridge === undefined) return;
    bridge.setTheme(name);
    const surface = (environment.surface ?? pageSurface)().trim();
    if (surface.length > 0) bridge.setWindowBackground(surface);
}

// A theme the person picked: applied now and remembered for the next launch.
export function switchTheme(choice: ThemeChoice): void {
    activateTheme(choice);
    storeTheme(resolveThemeChoice(choice));
}
