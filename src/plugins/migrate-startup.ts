import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { VeraConfig, VeraExtensionConfig } from "../config.ts";
import type { MigratedHostPath } from "./migrate.ts";

export function hasLegacyExtensionStores(home: string): boolean {
    const machine = join(home, "machine");
    const desktop = join(machine, "desktop");
    for (const boundary of [machine, desktop]) {
        try {
            if (lstatSync(boundary).isSymbolicLink()) return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    return [join(home, "extensions"), join(desktop, "extensions")].some((directory) =>
        !legacyStoreWasMigrated(directory) && (pathExists(directory) || pathExists(`${directory}.json`))
    );
}

export function legacyStoreWasMigrated(directory: string): boolean {
    return pathExists(`${directory}.pre-plugins`) || pathExists(`${directory}.pre-plugins.json`);
}

function pathExists(path: string): boolean {
    try { lstatSync(path); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}


export function createMigratedHostPathMapper(mappings: readonly MigratedHostPath[]): (config: VeraConfig) => VeraConfig {
    let previous: VeraConfig | undefined;
    let mapped: VeraConfig | undefined;
    return (config) => {
        if (config !== previous) {
            previous = config;
            mapped = applyMigratedHostPaths(config, mappings);
        }
        return mapped!;
    };
}

export function applyMigratedHostPaths(
    config: VeraConfig,
    mappings: readonly MigratedHostPath[],
): VeraConfig {
    if (mappings.length === 0 || config.extensions === undefined) return config;
    const existing = new Set(config.extensions.filter((entry) => isAbsolute(entry.path)).map((entry) => resolve(entry.path)));
    const extensions: VeraExtensionConfig[] = [];
    let changed = false;
    for (const entry of config.extensions) {
        if (!isAbsolute(entry.path)) {
            extensions.push(entry);
            continue;
        }
        const current = resolve(entry.path);
        const mapping = mappings.find(({ from }) => {
            const part = relative(resolve(from), current);
            return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
        });
        if (mapping === undefined) {
            extensions.push(entry);
            continue;
        }
        const target = join(mapping.to, relative(resolve(mapping.from), current));
        changed = true;
        if (!existing.has(resolve(target))) extensions.push({ ...entry, path: target });
    }
    return changed ? { ...config, extensions } : config;
}
