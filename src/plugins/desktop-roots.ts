import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { pluginDirectoryIn, pluginRegistryPathIn, pluginsDirectoryIn } from "../profile-paths.ts";
import { readPluginPartFolders } from "./manifest.ts";
import { isDirectory, isFile, isWithin } from "./package-files.ts";
import { assertSafePluginStore, readPluginRegistry } from "./registry.ts";

export interface DesktopPluginRoot {
    readonly plugin: string;
    readonly directory: string;
    readonly id: string | null;
}

export interface DesktopPluginClaim {
    readonly plugin: string;
    readonly id: string;
}

export interface DesktopPluginRoots {
    readonly roots: readonly DesktopPluginRoot[];
    readonly claims: readonly DesktopPluginClaim[];
    readonly warnings: readonly string[];
}

export function desktopPluginRoots(home: string): DesktopPluginRoots {
    const registryPath = pluginRegistryPathIn(home);
    let records;
    try {
        assertSafePluginStore(pluginsDirectoryIn(home), registryPath);
        records = readPluginRegistry(registryPath).plugins;
    } catch (error) {
        return { roots: [], claims: [], warnings: [`Plugins: ${message(error)}`] };
    }

    const roots: DesktopPluginRoot[] = [];
    const claims: DesktopPluginClaim[] = [];
    const warnings: string[] = [];
    for (const record of records.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (record.components.desktop_extension !== null) {
            claims.push({ plugin: record.name, id: record.components.desktop_extension });
        }
        if (!record.enabled) continue;
        const directory = pluginDirectoryIn(home, record.name);
        try {
            const details = lstatSync(directory);
            if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("the installed folder is not a directory");
            const packageRoot = realpathSync(directory);
            const parts = readPluginPartFolders(packageRoot);
            for (const warning of parts.warnings) warnings.push(`plugin ${record.name}: ${warning}`);
            const desktop = parts.desktop;
            if (!isDirectory(desktop) || !isFile(join(desktop, "vera.desktop.json"))) {
                if (record.components.desktop_extension !== null) throw new Error("the desktop extension folder is missing");
                continue;
            }
            const realDesktop = realpathSync(desktop);
            if (!isWithin(packageRoot, realDesktop)) throw new Error("the desktop extension leaves the plugin");
            roots.push({ plugin: record.name, directory: realDesktop, id: record.components.desktop_extension });
        } catch (error) {
            warnings.push(`plugin ${record.name}: ${message(error)}`);
        }
    }
    return { roots, claims, warnings };
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
