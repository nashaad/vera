import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { VeraExtensionConfig } from "../config.ts";
import { EXTENSION_MANIFEST_FILENAME, loadExtensionManifest } from "./manifest.ts";

export const CORE_EXTENSIONS_DIRECTORY = fileURLToPath(new URL("../core-extensions", import.meta.url));
export const SHIPPED_EXTENSIONS_DIRECTORY = fileURLToPath(new URL("../../extensions", import.meta.url));

export interface IncludedExtension {
    // Undefined when the manifest does not load; the registry reports that failure.
    readonly id: string | undefined;
    readonly path: string;
    readonly core: boolean;
}

// Every folder with a manifest loads. A missing directory or folder is skipped.
export function includedExtensions(): readonly IncludedExtension[] {
    return [
        ...scan(CORE_EXTENSIONS_DIRECTORY, true),
        ...scan(SHIPPED_EXTENSIONS_DIRECTORY, false),
    ];
}

export function includedExtensionIds(): readonly string[] {
    return includedExtensions().flatMap((extension) => extension.id === undefined ? [] : [extension.id]);
}

export function includedExtensionConfigs(
    disabledIds: readonly string[],
): readonly VeraExtensionConfig[] {
    return includedExtensions()
        .filter((extension) => extension.id === undefined || !disabledIds.includes(extension.id))
        .map((extension) => ({ path: extension.path, enabled: true, config: {} }));
}

function scan(directory: string, core: boolean): IncludedExtension[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name))
        .filter((path) => existsSync(join(path, EXTENSION_MANIFEST_FILENAME)))
        .sort()
        .map((path) => ({ id: manifestId(path), path, core }));
}

function manifestId(path: string): string | undefined {
    try {
        return loadExtensionManifest(path).manifest.id;
    } catch {
        return undefined;
    }
}
