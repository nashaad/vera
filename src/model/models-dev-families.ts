/**
 * The family each model belongs to, according to models.dev.
 *
 * Used only as a guard on version-chain folding: two ids that look like
 * successive versions are folded only when the community catalog agrees they
 * are the same model line. It is a second opinion on a rule that already
 * decided, never the rule itself, which is why an unreachable models.dev costs
 * a slightly longer list rather than a broken picker.
 *
 * Cached for a week. A family is a slow fact: a model does not change lines,
 * and a new model that is missing from the cache simply does not get folded
 * until the next refresh.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { providerCatalogCacheDir } from "./catalog-cache.ts";

const ENDPOINT = "https://models.dev/api.json";
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_FILE = "models-dev-families.json";
export const FAMILY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ModelFamilyOptions {
    readonly cacheDir?: string;
    readonly endpoint?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    /** Milliseconds since the epoch. Passed in so staleness stays testable. */
    readonly now?: number;
}

/** What the cache file holds: a family per model id, and when it was fetched. */
interface FamilyCache {
    readonly fetched_at: number;
    readonly families: Readonly<Record<string, string>>;
}

/**
 * The family map, refreshed only when what Vera holds is older than a week.
 *
 * Never throws and never returns nothing on a failed fetch: a stale map is a
 * better answer than no map, and no map is still an answer.
 */
export async function modelFamilies(
    options: ModelFamilyOptions = {},
): Promise<ReadonlyMap<string, string>> {
    const now = options.now ?? Date.now();
    const held = readFamilyCache(options);
    if (held !== undefined && now - held.fetched_at < FAMILY_CACHE_MAX_AGE_MS) {
        return new Map(Object.entries(held.families));
    }

    const fetched = await fetchFamilies(options);
    if (fetched === undefined) {
        return held === undefined
            ? new Map()
            : new Map(Object.entries(held.families));
    }
    writeFamilyCache({ fetched_at: now, families: fetched }, options);
    return new Map(Object.entries(fetched));
}

async function fetchFamilies(
    options: ModelFamilyOptions,
): Promise<Record<string, string> | undefined> {
    let raw: unknown;
    try {
        const response = await (options.fetch ?? globalThis.fetch)(
            options.endpoint ?? ENDPOINT,
            {
                signal: AbortSignal.timeout(
                    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                ),
            },
        );
        if (!response.ok) {
            return undefined;
        }
        raw = await response.json();
    } catch {
        return undefined;
    }
    const families = openRouterFamilies(raw);
    // A reachable endpoint that answered with nothing usable is the same
    // situation as an unreachable one: it must not overwrite what Vera holds.
    return Object.keys(families).length === 0 ? undefined : families;
}

/**
 * Only the OpenRouter section is kept. The full document covers 184 providers
 * and runs to several megabytes, and the picker only folds within one provider,
 * so storing the rest would be storing it for nobody.
 */
export function openRouterFamilies(raw: unknown): Record<string, string> {
    const families: Record<string, string> = {};
    if (!isRecord(raw)) {
        return families;
    }
    const provider = raw.openrouter;
    if (!isRecord(provider) || !isRecord(provider.models)) {
        return families;
    }
    for (const [id, model] of Object.entries(provider.models)) {
        if (isRecord(model) && typeof model.family === "string"
            && model.family.length > 0) {
            families[id] = model.family;
        }
    }
    return families;
}

function familyCachePath(options: ModelFamilyOptions): string {
    return join(options.cacheDir ?? providerCatalogCacheDir(), CACHE_FILE);
}

function readFamilyCache(
    options: ModelFamilyOptions,
): FamilyCache | undefined {
    try {
        const value: unknown = JSON.parse(
            readFileSync(familyCachePath(options), "utf8"),
        );
        if (!isRecord(value) || typeof value.fetched_at !== "number"
            || !isRecord(value.families)) {
            return undefined;
        }
        const families: Record<string, string> = {};
        for (const [id, family] of Object.entries(value.families)) {
            if (typeof family === "string") {
                families[id] = family;
            }
        }
        return { fetched_at: value.fetched_at, families };
    } catch {
        return undefined;
    }
}

function writeFamilyCache(
    cache: FamilyCache,
    options: ModelFamilyOptions,
): void {
    const directory = options.cacheDir ?? providerCatalogCacheDir();
    const path = join(directory, CACHE_FILE);
    const temporaryPath = join(directory, `.families-${randomUUID()}.tmp`);
    try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`);
        renameSync(temporaryPath, path);
    } catch {
        // A cache Vera cannot write is not a reason to drop a map it just
        // fetched. The next start tries again.
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
