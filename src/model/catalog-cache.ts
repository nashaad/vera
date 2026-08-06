import {
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderCatalog } from "./catalog-shape.ts";

export interface ProviderCatalogCacheOptions {
    readonly cacheDir?: string;
}

/**
 * The directory discovery snapshots live in. A snapshot's filename is always
 * derived from its provider, so callers override the directory, never the
 * filename: that is what lets one options object configure both the writer
 * here and the loader in `catalog.ts`.
 */
export function providerCatalogCacheDir(): string {
    return join(homedir(), ".vera", "cache");
}

export function providerCatalogCachePath(
    provider: string,
    cacheDir = providerCatalogCacheDir(),
): string {
    return join(cacheDir, `${provider}.json`);
}

export function writeProviderCatalogSnapshot(
    catalog: ProviderCatalog,
    options: ProviderCatalogCacheOptions = {},
): void {
    const directory = options.cacheDir ?? providerCatalogCacheDir();
    const path = providerCatalogCachePath(catalog.provider, directory);
    const temporaryPath = join(
        directory,
        `.${catalog.provider}-${randomUUID()}.tmp`,
    );

    mkdirSync(directory, { recursive: true });
    writeFileSync(
        temporaryPath,
        `${JSON.stringify(catalog, null, 2)}\n`,
    );
    renameSync(temporaryPath, path);
}

export function readProviderCatalogSnapshot(
    provider: string,
    options: ProviderCatalogCacheOptions = {},
): ProviderCatalog {
    const path = providerCatalogCachePath(provider, options.cacheDir);

    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isProviderCatalog(value) ? value : emptyCatalog(provider);
    } catch {
        return emptyCatalog(provider);
    }
}

/**
 * The providers discovery has ever written a snapshot for. A missing or
 * unreadable directory is an empty list, not an error: discovery may simply
 * never have run.
 */
export function listDiscoveredProviders(
    options: ProviderCatalogCacheOptions = {},
): readonly string[] {
    const directory = options.cacheDir ?? providerCatalogCacheDir();
    try {
        return readdirSync(directory)
            .filter((name) => name.endsWith(".json") && !name.startsWith("."))
            .map((name) => name.slice(0, -".json".length));
    } catch {
        return [];
    }
}

function isProviderCatalog(value: unknown): value is ProviderCatalog {
    if (
        !isRecord(value)
        || value.schema_version !== 2
        || typeof value.provider !== "string"
        || !Array.isArray(value.models)
    ) {
        return false;
    }

    return value.models.every((model) =>
        isRecord(model)
        && typeof model.id === "string"
        && typeof model.label === "string"
        && Array.isArray(model.levels)
        && model.levels.every((level) =>
            isRecord(level)
            && typeof level.id === "string"
            && typeof level.label === "string"
        )
    );
}

function emptyCatalog(provider: string): ProviderCatalog {
    return {
        schema_version: 2,
        provider,
        models: [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
