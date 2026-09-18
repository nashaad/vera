import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { veraRuntimeDirectory } from "../profile-paths.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

export const CURATED_SCHEMA_VERSION = 3;

/** One curated pick. `make` names who built it and is not matched against provider ids, which namespace differently. */
export interface CuratedModel {
    readonly make: string;
    readonly model: string;
    readonly note?: string;
}

export interface CuratedList {
    readonly schema_version: typeof CURATED_SCHEMA_VERSION;
    readonly updated_at: string;
    readonly about?: string;
    readonly models: readonly CuratedModel[];
}

export interface CuratedCache {
    readonly fetched_at: string;
    readonly list: CuratedList;
}

export const CURATED_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

export function curatedCachePath(runtimeDir = veraRuntimeDirectory()): string {
    return join(runtimeDir, "curated-models.json");
}

export interface CuratedFetch {
    (url: string, init?: RequestInit): Promise<Response>;
}

export interface RefreshCuratedOptions {
    readonly url?: string;
    readonly fetch?: CuratedFetch;
    readonly path?: string;
    readonly now?: number;
    readonly signal?: AbortSignal;
}

export interface CuratedResult {
    readonly list?: CuratedList;
    readonly source: "fetched" | "cache" | "none";
    readonly refusal?: string;
}

export function readCuratedCache(
    path = curatedCachePath(),
): CuratedCache | undefined {
    try {
        const value: unknown = JSON.parse(readRegularFileTextSync(path));
        return parseCache(value);
    } catch {
        return undefined;
    }
}

export function curatedModels(path = curatedCachePath()): readonly CuratedModel[] {
    return readCuratedCache(path)?.list.models ?? [];
}

/**
 * Fetches the curated list unless the cached copy is still within the day.
 * A fetch that fails leaves the cache in place and names why.
 */
export async function refreshCuratedModels(
    options: RefreshCuratedOptions = {},
): Promise<CuratedResult> {
    const path = options.path ?? curatedCachePath();
    const now = options.now ?? Date.now();
    const cached = readCuratedCache(path);
    if (options.url === undefined) {
        return cached === undefined
            ? { source: "none" }
            : { list: cached.list, source: "cache" };
    }
    if (cached !== undefined && isFresh(cached, now)) {
        return { list: cached.list, source: "cache" };
    }
    const fetched = await fetchCurated(options.url, options);
    if (typeof fetched === "string") {
        return {
            ...(cached === undefined ? {} : { list: cached.list }),
            source: cached === undefined ? "none" : "cache",
            refusal: fetched,
        };
    }
    writeCuratedCache({ fetched_at: new Date(now).toISOString(), list: fetched }, path);
    return { list: fetched, source: "fetched" };
}

export function writeCuratedCache(
    cache: CuratedCache,
    path = curatedCachePath(),
): void {
    const directory = dirname(path);
    const temporaryPath = join(directory, `.curated-${randomUUID()}.tmp`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`);
    renameSync(temporaryPath, path);
}

/**
 * The key a curated entry and a provider listing are compared on: the id past
 * its namespace, without the batch suffix or the dated release that providers
 * append to the same model.
 */
export function curatedKey(id: string): string {
    const tail = id.replace(/^~/, "").split("/").at(-1) ?? id;
    return tail
        .toLowerCase()
        .replace(/:.*$/, "")
        .replace(/-\d{4,}$/, "");
}

export function curatedKeys(models: readonly CuratedModel[]): ReadonlySet<string> {
    return new Set(models.map((entry) => curatedKey(entry.model)));
}

/**
 * The ids a provider listing answers the curated picks with: one per pick,
 * preferring the plain id over a dated release of the same model. Batch and
 * other suffixed variants are not picks, whatever they are variants of.
 */
export function curatedSelection(
    ids: readonly string[],
    keys: ReadonlySet<string>,
): ReadonlySet<string> {
    const best = new Map<string, string>();
    for (const id of ids) {
        if (id.includes(":")) continue;
        const key = curatedKey(id);
        if (!keys.has(key)) continue;
        const rival = best.get(key);
        if (rival === undefined || preferred(id, rival) === id) {
            best.set(key, id);
        }
    }
    return new Set(best.values());
}

function preferred(left: string, right: string): string {
    const leftDate = releaseDate(left);
    const rightDate = releaseDate(right);
    if (leftDate === rightDate) return left.length <= right.length ? left : right;
    // An undated id names the model itself; a dated one names one of its releases.
    if (leftDate === undefined) return left;
    if (rightDate === undefined) return right;
    return leftDate > rightDate ? left : right;
}

function releaseDate(id: string): string | undefined {
    return /-(\d{4,})$/.exec(id)?.[1];
}

async function fetchCurated(
    url: string,
    options: RefreshCuratedOptions,
): Promise<CuratedList | string> {
    const doFetch = options.fetch ?? globalThis.fetch;
    try {
        const response = await doFetch(url, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (!response.ok) {
            return `curated fetch answered ${response.status}`;
        }
        const parsed = parseCuratedList(await response.json());
        return parsed ?? "curated list did not parse";
    } catch (error) {
        return error instanceof Error ? error.message : "curated fetch failed";
    }
}

function isFresh(cache: CuratedCache, now: number): boolean {
    const fetchedAt = Date.parse(cache.fetched_at);
    if (Number.isNaN(fetchedAt)) {
        return false;
    }
    const age = now - fetchedAt;
    return age >= 0 && age < CURATED_FRESHNESS_MS;
}

export function parseCuratedList(value: unknown): CuratedList | undefined {
    const list = asRecord(value);
    if (
        list === undefined
        || list.schema_version !== CURATED_SCHEMA_VERSION
        || typeof list.updated_at !== "string"
        || (list.about !== undefined && typeof list.about !== "string")
        || !Array.isArray(list.models)
    ) {
        return undefined;
    }
    const models = list.models
        .map(parseCuratedModel)
        .filter((model): model is CuratedModel => model !== undefined);
    return {
        schema_version: CURATED_SCHEMA_VERSION,
        updated_at: list.updated_at,
        ...(list.about === undefined ? {} : { about: list.about as string }),
        models,
    };
}

function parseCuratedModel(value: unknown): CuratedModel | undefined {
    const model = asRecord(value);
    if (
        model === undefined
        || typeof model.make !== "string"
        || model.make.trim().length === 0
        || typeof model.model !== "string"
        || model.model.trim().length === 0
        || (model.note !== undefined && typeof model.note !== "string")
    ) {
        return undefined;
    }
    return {
        make: model.make.trim(),
        model: model.model.trim(),
        ...(model.note === undefined ? {} : { note: (model.note as string).trim() }),
    };
}

function parseCache(value: unknown): CuratedCache | undefined {
    const cache = asRecord(value);
    if (cache === undefined || typeof cache.fetched_at !== "string") {
        return undefined;
    }
    const list = parseCuratedList(cache.list);
    return list === undefined
        ? undefined
        : { fetched_at: cache.fetched_at, list };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

/** The curated list this build looks for when the config names no other address. */
export const DEFAULT_CURATED_URL =
    "https://gist.githubusercontent.com/nashaad/d5b0bce9a985482faa128560716eb881/raw/vera-curated.json";

export interface CuratedRefresh {
    close(): void;
}

/**
 * Refreshes the curated list once at startup and once a day after that. The
 * fetch never blocks the caller: the cache on disk answers until it lands.
 */
export function startCuratedRefresh(
    options: RefreshCuratedOptions & { readonly onResult?: (result: CuratedResult) => void } = {},
): CuratedRefresh {
    const url = options.url ?? DEFAULT_CURATED_URL;
    if (url === "") {
        return { close: () => {} };
    }
    const controller = new AbortController();
    const run = (): void => {
        void refreshCuratedModels({ ...options, url, signal: controller.signal })
            .then((result) => options.onResult?.(result))
            .catch(() => {});
    };
    run();
    const timer = setInterval(run, CURATED_FRESHNESS_MS);
    timer.unref?.();
    return {
        close: () => {
            clearInterval(timer);
            controller.abort();
        },
    };
}
