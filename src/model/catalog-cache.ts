import {
    mkdirSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import type { ProviderCatalog } from "./catalog-shape.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";
import { isSafeProviderId } from "../providers/provider-id.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

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
    return join(veraRuntimeDirectory(), "cache");
}

export function providerCatalogCachePath(
    provider: string,
    cacheDir = providerCatalogCacheDir(),
): string {
    if (!isSafeProviderId(provider)) {
        throw new Error(`Unsafe provider catalog id ${JSON.stringify(provider)}`);
    }
    const directory = resolve(cacheDir);
    const path = resolve(directory, `${provider}.json`);
    if (dirname(path) !== directory) {
        throw new Error(`Provider catalog path escaped ${directory}`);
    }
    return path;
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

/**
 * How long a discovery snapshot answers for before the provider is asked
 * again. A week: model lists change slowly, and a week-old list is a far
 * better answer to "which models can I run" than a network call on every
 * start, which is what launching Vera used to cost.
 */
export const DEFAULT_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The snapshot when it is young enough to answer without asking the provider,
 * and `undefined` when the caller has to fetch.
 *
 * A snapshot with no models, no `fetched_at`, or an unreadable one is not
 * fresh: none of them can say when they were taken, and an empty picker is
 * worse than one wait. A `fetched_at` in the future is not fresh either, so a
 * clock that jumped forward once cannot pin a stale list there permanently.
 */
export function readFreshProviderCatalogSnapshot(
    provider: string,
    maxAgeMs: number,
    options: ProviderCatalogCacheOptions = {},
): ProviderCatalog | undefined {
    if (!(maxAgeMs > 0)) {
        return undefined;
    }
    const snapshot = readProviderCatalogSnapshot(provider, options);
    if (snapshot.models.length === 0 || snapshot.fetched_at === undefined) {
        return undefined;
    }
    const fetchedAt = Date.parse(snapshot.fetched_at);
    if (Number.isNaN(fetchedAt)) {
        return undefined;
    }
    const age = Date.now() - fetchedAt;
    return age >= 0 && age < maxAgeMs ? snapshot : undefined;
}

export function readProviderCatalogSnapshot(
    provider: string,
    options: ProviderCatalogCacheOptions = {},
): ProviderCatalog {
    const path = providerCatalogCachePath(provider, options.cacheDir);

    try {
        const value: unknown = JSON.parse(readRegularFileTextSync(path));
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
            .filter((name) =>
                name.endsWith(".json")
                && !name.startsWith(".")
                && name !== "webdev-arena.json"
            )
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
