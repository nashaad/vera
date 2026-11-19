import { join } from "node:path";

// Folders whose names start with this are unpacked or replaced extensions that are not installed yet.
export const STAGING_PREFIX = ".staging-";

export function extensionsDirectory(home: string): string {
    return join(home, "machine", "desktop", "extensions");
}

export function extensionStatePath(home: string): string {
    return join(home, "machine", "desktop", "extensions.json");
}

// Extensions that ship inside the app sit in this folder of the bundle, next to main.js.
export function includedExtensionsDirectory(bundleDirectory: string): string {
    return join(bundleDirectory, "extensions");
}
