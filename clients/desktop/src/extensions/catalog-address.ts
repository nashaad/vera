declare const __VERA_CATALOG_URL__: string | undefined;

// The catalog this build reads, written in when the app is built. Undefined when the build names none.
export function catalogAddress(): string | undefined {
    return typeof __VERA_CATALOG_URL__ === "string" ? __VERA_CATALOG_URL__ : undefined;
}
