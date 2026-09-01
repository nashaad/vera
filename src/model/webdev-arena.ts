
import {
    mkdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { providerCatalogCacheDir } from "./catalog-cache.ts";
import { readRegularFileTextSync } from "../store/regular-file.ts";

export const WEBDEV_ARENA_CACHE_FILE = "webdev-arena.json";

const ROWS_ENDPOINT =
    "https://datasets-server.huggingface.co/rows";
const DATASET = "lmarena-ai/leaderboard-dataset";
const CONFIG = "webdev";
const SPLIT = "latest";
const PAGE_LENGTH = 100;
const DEFAULT_TIMEOUT_MS = 8000;

export interface WebDevArenaRow {
    readonly model_name: string;
    readonly rating: number;
    readonly category: string;
    readonly rank?: number;
    readonly vote_count?: number;
}

export interface WebDevArenaSnapshot {
    readonly schema_version: 1;
    readonly source: "lmarena-ai/leaderboard-dataset";
    readonly config: "webdev";
    readonly split: "latest";
    readonly license: "CC-BY-4.0";
    readonly fetched_at: string;
    readonly leaderboard_publish_date?: string;
    readonly rows: readonly WebDevArenaRow[];
}

export interface WebDevArenaRefreshOptions {
    readonly cacheDir?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    readonly maxAgeMs?: number;
    readonly endpoint?: string;
}

export function webDevArenaCachePath(
    cacheDir = providerCatalogCacheDir(),
): string {
    const directory = resolve(cacheDir);
    const path = resolve(directory, WEBDEV_ARENA_CACHE_FILE);
    if (dirname(path) !== directory) {
        throw new Error(`WebDev Arena cache path escaped ${directory}`);
    }
    return path;
}

export function webDevArenaSnapshotDate(
    snapshot: WebDevArenaSnapshot | undefined,
): string | undefined {
    if (snapshot === undefined) {
        return undefined;
    }
    if (
        snapshot.leaderboard_publish_date !== undefined
        && snapshot.leaderboard_publish_date.length > 0
    ) {
        return snapshot.leaderboard_publish_date;
    }
    const fetched = Date.parse(snapshot.fetched_at);
    if (Number.isNaN(fetched)) {
        return undefined;
    }
    return new Date(fetched).toISOString().slice(0, 10);
}

export function readWebDevArenaSnapshot(
    cacheDir?: string,
): WebDevArenaSnapshot | undefined {
    try {
        const value: unknown = JSON.parse(
            readRegularFileTextSync(webDevArenaCachePath(cacheDir)),
        );
        return parseWebDevArenaSnapshot(value);
    } catch {
        return undefined;
    }
}

export function readFreshWebDevArenaSnapshot(
    maxAgeMs: number,
    cacheDir?: string,
): WebDevArenaSnapshot | undefined {
    if (!(maxAgeMs > 0)) {
        return undefined;
    }
    const snapshot = readWebDevArenaSnapshot(cacheDir);
    if (snapshot === undefined) {
        return undefined;
    }
    const fetchedAt = Date.parse(snapshot.fetched_at);
    if (Number.isNaN(fetchedAt)) {
        return undefined;
    }
    const age = Date.now() - fetchedAt;
    return age >= 0 && age < maxAgeMs ? snapshot : undefined;
}

export async function refreshWebDevArena(
    options: WebDevArenaRefreshOptions = {},
): Promise<WebDevArenaSnapshot | undefined> {
    const cacheDir = options.cacheDir;
    const fresh = readFreshWebDevArenaSnapshot(
        options.maxAgeMs ?? 0,
        cacheDir,
    );
    if (fresh !== undefined) {
        return fresh;
    }
    const previous = readWebDevArenaSnapshot(cacheDir);
    try {
        const fetched = await fetchWebDevArenaRows(options);
        if (fetched === undefined || fetched.rows.length === 0) {
            return previous;
        }
        writeWebDevArenaSnapshot(fetched, cacheDir);
        return fetched;
    } catch {
        return previous;
    }
}

export function parseWebDevArenaSnapshot(
    value: unknown,
): WebDevArenaSnapshot | undefined {
    const record = asRecord(value);
    if (
        record === undefined
        || record.schema_version !== 1
        || record.source !== "lmarena-ai/leaderboard-dataset"
        || record.config !== "webdev"
        || record.split !== "latest"
        || typeof record.license !== "string"
        || typeof record.fetched_at !== "string"
        || !Array.isArray(record.rows)
    ) {
        return undefined;
    }
    const rows: WebDevArenaRow[] = [];
    for (const entry of record.rows) {
        const row = parseWebDevArenaRow(entry);
        if (row !== undefined) {
            rows.push(row);
        }
    }
    return {
        schema_version: 1,
        source: "lmarena-ai/leaderboard-dataset",
        config: "webdev",
        split: "latest",
        license: "CC-BY-4.0",
        fetched_at: record.fetched_at,
        ...(typeof record.leaderboard_publish_date === "string"
                && record.leaderboard_publish_date.length > 0
            ? { leaderboard_publish_date: record.leaderboard_publish_date }
            : {}),
        rows,
    };
}

function parseWebDevArenaRow(value: unknown): WebDevArenaRow | undefined {
    const row = asRecord(value);
    if (
        row === undefined
        || typeof row.model_name !== "string"
        || row.model_name.length === 0
        || typeof row.category !== "string"
        || typeof row.rating !== "number"
        || !Number.isFinite(row.rating)
    ) {
        return undefined;
    }
    return {
        model_name: row.model_name,
        rating: row.rating,
        category: row.category,
        ...(typeof row.rank === "number" && Number.isFinite(row.rank)
            ? { rank: row.rank }
            : {}),
        ...(typeof row.vote_count === "number" && Number.isFinite(row.vote_count)
            ? { vote_count: row.vote_count }
            : {}),
    };
}

async function fetchWebDevArenaRows(
    options: WebDevArenaRefreshOptions,
): Promise<WebDevArenaSnapshot | undefined> {
    const fetchFn = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const rows: WebDevArenaRow[] = [];
    let publishDate: string | undefined;
    try {
        let offset = 0;
        let total = Number.POSITIVE_INFINITY;
        while (offset < total) {
            const url = rowsUrl(options.endpoint, offset);
            const response = await fetchFn(url, { signal: controller.signal });
            if (!response.ok) {
                return undefined;
            }
            const body: unknown = await response.json();
            const page = parseRowsPage(body);
            if (page === undefined) {
                return undefined;
            }
            total = page.numRowsTotal;
            if (page.publishDate !== undefined && publishDate === undefined) {
                publishDate = page.publishDate;
            }
            rows.push(...page.rows);
            if (page.rows.length === 0) {
                break;
            }
            offset += PAGE_LENGTH;
        }
    } finally {
        clearTimeout(timer);
    }
    if (rows.length === 0) {
        return undefined;
    }
    return {
        schema_version: 1,
        source: "lmarena-ai/leaderboard-dataset",
        config: "webdev",
        split: "latest",
        license: "CC-BY-4.0",
        fetched_at: new Date().toISOString(),
        ...(publishDate === undefined ? {} : { leaderboard_publish_date: publishDate }),
        rows,
    };
}

function rowsUrl(endpoint: string | undefined, offset: number): string {
    if (endpoint !== undefined) {
        const url = new URL(endpoint);
        url.searchParams.set("offset", String(offset));
        url.searchParams.set("length", String(PAGE_LENGTH));
        return url.toString();
    }
    const url = new URL(ROWS_ENDPOINT);
    url.searchParams.set("dataset", DATASET);
    url.searchParams.set("config", CONFIG);
    url.searchParams.set("split", SPLIT);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(PAGE_LENGTH));
    return url.toString();
}

interface RowsPage {
    readonly numRowsTotal: number;
    readonly publishDate?: string;
    readonly rows: readonly WebDevArenaRow[];
}

function parseRowsPage(value: unknown): RowsPage | undefined {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record.rows)) {
        return undefined;
    }
    const total = record.num_rows_total;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
        return undefined;
    }
    const rows: WebDevArenaRow[] = [];
    let publishDate: string | undefined;
    for (const entry of record.rows) {
        const wrapped = asRecord(entry);
        const raw = wrapped === undefined
            ? undefined
            : asRecord(wrapped.row) ?? wrapped;
        const row = parseWebDevArenaRow(raw);
        if (row !== undefined) {
            rows.push(row);
        }
        if (publishDate === undefined && raw !== undefined) {
            const date = raw.leaderboard_publish_date;
            if (typeof date === "string" && date.length > 0) {
                publishDate = date;
            }
        }
    }
    return {
        numRowsTotal: total,
        ...(publishDate === undefined ? {} : { publishDate }),
        rows,
    };
}

function writeWebDevArenaSnapshot(
    snapshot: WebDevArenaSnapshot,
    cacheDir = providerCatalogCacheDir(),
): void {
    const directory = resolve(cacheDir);
    const path = webDevArenaCachePath(directory);
    const temporaryPath = join(
        directory,
        `.webdev-arena-${randomUUID()}.tmp`,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(temporaryPath, path);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
