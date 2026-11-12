import type { DesktopBridge } from "../protocol/bridge.ts";
import { applyTheme, type ThemeRoot } from "./apply.ts";
import type { ThemeName } from "./tokens.ts";

export interface ThemeEnvironment {
    readonly root?: ThemeRoot;
    readonly bridge?: Pick<DesktopBridge, "setWindowBackground">;
    readonly surface?: () => string;
}

function pageSurface(): string {
    return getComputedStyle(document.documentElement).getPropertyValue("--vera-surface");
}

// Applies a theme, then reports the resolved surface color so the native window
// behind the page matches it; the page paints a frame late during a resize.
export function activateTheme(name: ThemeName, environment: ThemeEnvironment = {}): void {
    applyTheme(name, environment.root ?? document.documentElement);
    const bridge = environment.bridge ?? globalThis.window?.veraDesktop;
    if (bridge === undefined) return;
    const surface = (environment.surface ?? pageSurface)().trim();
    if (surface.length > 0) bridge.setWindowBackground(surface);
}
