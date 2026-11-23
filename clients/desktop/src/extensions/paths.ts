import { join } from "node:path";

import { desktopPluginRoots, type DesktopPluginClaim } from "../../../../src/plugins/desktop-roots.ts";
import { extensionsDirectory } from "../extension-files.ts";

export { extensionsDirectory };

// Folders whose names start with this are unpacked or replaced extensions that are not installed yet.
export const STAGING_PREFIX = ".staging-";

export interface FolderExtensionRoot {
    readonly directory: string;
    readonly kind: "included" | "installed";
}

export interface PluginExtensionRoot {
    readonly directory: string;
    readonly kind: "plugin";
    readonly plugin: string;
    readonly id: string | null;
}

export type ExtensionRoot = FolderExtensionRoot | PluginExtensionRoot;

export interface ExtensionRoots {
    readonly roots: readonly ExtensionRoot[];
    readonly claims: readonly DesktopPluginClaim[];
    readonly warnings: readonly string[];
}

export function extensionRoots(home: string, included?: string): ExtensionRoots {
    const plugins = desktopPluginRoots(home);
    return {
        roots: [
            ...(included === undefined ? [] : [{ directory: included, kind: "included" as const }]),
            ...plugins.roots.map((part) => ({ directory: part.directory, kind: "plugin" as const, plugin: part.plugin, id: part.id })),
            { directory: extensionsDirectory(home), kind: "installed" },
        ],
        claims: plugins.claims,
        warnings: plugins.warnings,
    };
}

export function extensionStatePath(home: string): string {
    return join(home, "machine", "desktop", "extensions.json");
}

// Extensions that ship inside the app sit in this folder of the bundle, next to main.js.
export function includedExtensionsDirectory(bundleDirectory: string): string {
    return join(bundleDirectory, "extensions");
}
