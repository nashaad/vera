// The name build.ts defines in the main bundle.
export const DESKTOP_BUILD_ID_SYMBOL = "__VERA_DESKTOP_BUILD_ID__";

declare const __VERA_DESKTOP_BUILD_ID__: string | undefined;

// Undefined when the source runs unbundled, or the bundle was built where git could not name a build.
export function desktopClientBuildId(): string | undefined {
    if (typeof __VERA_DESKTOP_BUILD_ID__ !== "string" || __VERA_DESKTOP_BUILD_ID__.length === 0) return undefined;
    return __VERA_DESKTOP_BUILD_ID__;
}
