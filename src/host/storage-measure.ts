import { lstat, opendir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import { readSessionIndexMetadata } from "../store/session-store.ts";
import {
    type StorageCategoryMeasurement,
    type StorageLargestItem,
    type StorageMeasurement,
} from "./storage-protocol.ts";

export const STORAGE_MEASURE_ENTRY_LIMIT = 200_000;
const LARGEST_ITEMS = 10;

export interface StorageMeasureOptions {
    readonly home: string;
    readonly sessionDirectory: string;
    readonly logDirectory: string;
    // A throw here means the home cannot have scratch; the category is empty.
    readonly scratchDirectory: string | (() => string);
    readonly tempRoot?: string;
    readonly now?: () => Date;
    readonly entryLimit?: number;
}

export interface StorageMeasurer {
    measure(refresh: boolean): Promise<StorageMeasurement>;
}

interface Budget {
    remaining: number;
    partial: boolean;
}

interface Totals {
    bytes: number;
    items: number;
}

interface Visit {
    readonly totals: Totals;
    readonly directory: boolean;
}

const EMPTY_TOTALS: Totals = { bytes: 0, items: 0 };

function take(budget: Budget): boolean {
    if (budget.remaining <= 0) {
        budget.partial = true;
        return false;
    }
    budget.remaining -= 1;
    return true;
}

// A symlink is counted as one item, never as its target.
function entryBytes(stats: { readonly size: number; isSymbolicLink(): boolean }): number {
    return stats.isSymbolicLink() ? 0 : stats.size;
}

async function walkDirectory(
    directory: string,
    budget: Budget,
    skip: ReadonlySet<string>,
): Promise<Totals> {
    let handle;
    try {
        handle = await opendir(directory);
    } catch {
        return EMPTY_TOTALS;
    }
    const totals = { bytes: 0, items: 0 };
    try {
        for await (const entry of handle) {
            const path = join(directory, entry.name);
            if (skip.has(resolve(path))) continue;
            if (!take(budget)) break;
            const visited = await visitEntry(path, budget, skip);
            totals.bytes += visited.totals.bytes;
            totals.items += visited.totals.items;
        }
    } catch {
        // A directory that turns unreadable mid-walk is measured as far as it was read.
    }
    return totals;
}

// The entry itself has already been taken from the budget.
async function visitEntry(
    path: string,
    budget: Budget,
    skip: ReadonlySet<string>,
): Promise<Visit> {
    let stats;
    try {
        stats = await lstat(path);
    } catch {
        return { totals: EMPTY_TOTALS, directory: false };
    }
    if (stats.isDirectory()) {
        return { totals: await walkDirectory(path, budget, skip), directory: true };
    }
    return { totals: { bytes: entryBytes(stats), items: 1 }, directory: false };
}

async function measureRoot(
    path: string,
    budget: Budget,
    skip: ReadonlySet<string> = new Set(),
): Promise<Totals> {
    let stats;
    try {
        stats = await lstat(path);
    } catch {
        return EMPTY_TOTALS;
    }
    if (stats.isDirectory()) return walkDirectory(path, budget, skip);
    if (!take(budget)) return EMPTY_TOTALS;
    return { bytes: entryBytes(stats), items: 1 };
}

interface Candidate {
    readonly key: string;
    readonly bytes: number;
    readonly titlePath?: string;
}

class Largest {
    private readonly items: Candidate[] = [];

    add(key: string, bytes: number, titlePath?: string): void {
        if (bytes <= 0) return;
        this.items.push(titlePath === undefined ? { key, bytes } : { key, bytes, titlePath });
        this.items.sort((left, right) => right.bytes - left.bytes || left.key.localeCompare(right.key));
        if (this.items.length > 20) this.items.length = 20;
    }

    // Titles are read for the ten shown items only, never for every session on disk.
    async list(): Promise<readonly StorageLargestItem[]> {
        const top = this.items.slice(0, LARGEST_ITEMS);
        const items: StorageLargestItem[] = [];
        for (const candidate of top) {
            const title = candidate.titlePath === undefined
                ? undefined
                : await titleFor(candidate.titlePath);
            items.push({ name: title ?? candidate.key, bytes: candidate.bytes });
        }
        return items;
    }

    async merged(other: readonly StorageLargestItem[]): Promise<void> {
        for (const item of other) this.add(item.name, item.bytes);
    }
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

function displayPath(from: string, path: string): string {
    return relative(from, path).split(sep).join("/");
}

async function titleFor(sessionPath: string): Promise<string | undefined> {
    try {
        const title = (await readSessionIndexMetadata(sessionPath)).title?.trim();
        return title === undefined || title.length === 0 ? undefined : title;
    } catch {
        return undefined;
    }
}

function sessionArtifactId(name: string): string | undefined {
    const marker = ".jsonl";
    const at = name.indexOf(marker);
    if (at <= 0) return undefined;
    const suffix = name.slice(at);
    if (suffix === marker
        || suffix === `${marker}.attachments`
        || suffix === `${marker}.files`
        || suffix === `${marker}.metadata.json`) {
        return name.slice(0, at);
    }
    return undefined;
}

async function measureSessions(
    sessionDirectory: string,
    runtimeDirectory: string,
    budget: Budget,
): Promise<StorageCategoryMeasurement> {
    let names: string[];
    try {
        names = await readdir(sessionDirectory);
    } catch {
        names = [];
    }
    names.sort();
    const largest = new Largest();
    let bytes = 0;
    let items = 0;
    let sessionCount = 0;
    let index = 0;
    while (index < names.length) {
        const name = names[index]!;
        if (!take(budget)) break;
        const id = sessionArtifactId(name);
        if (id === undefined) {
            const visited = await visitEntry(join(sessionDirectory, name), budget, new Set());
            bytes += visited.totals.bytes;
            items += visited.totals.items;
            largest.add(name, visited.totals.bytes);
            index += 1;
            continue;
        }
        let groupBytes = 0;
        let groupItems = 0;
        let hasSession = false;
        let firstPart = true;
        while (index < names.length && sessionArtifactId(names[index]!) === id) {
            if (!firstPart && !take(budget)) break;
            const visited = await visitEntry(join(sessionDirectory, names[index]!), budget, new Set());
            groupBytes += visited.totals.bytes;
            groupItems += visited.totals.items;
            if (names[index] === `${id}.jsonl`) hasSession = true;
            firstPart = false;
            index += 1;
        }
        bytes += groupBytes;
        items += groupItems;
        if (hasSession) sessionCount += 1;
        largest.add(
            id,
            groupBytes,
            hasSession ? join(sessionDirectory, `${id}.jsonl`) : undefined,
        );
        if (budget.remaining <= 0) break;
    }
    const databases = await measureDatabases(runtimeDirectory, budget, largest);
    bytes += databases.bytes;
    items += databases.items;
    const summaryParts = [plural(sessionCount, "session", "sessions")];
    if (databases.count > 0) summaryParts.push(plural(databases.count, "database", "databases"));
    return {
        category: "sessions",
        bytes,
        items,
        summary: summaryParts.join(" and "),
        largest: await largest.list(),
    };
}

async function measureDatabases(
    runtimeDirectory: string,
    budget: Budget,
    largest: Largest,
): Promise<{ bytes: number; items: number; count: number }> {
    let names: string[];
    try {
        names = await readdir(runtimeDirectory);
    } catch {
        return { bytes: 0, items: 0, count: 0 };
    }
    let bytes = 0;
    let items = 0;
    let count = 0;
    for (const database of ["inbox.db", "schedules.db"]) {
        const members = names.filter((name) => name === database || name.startsWith(`${database}-`)).sort();
        if (members.length === 0) continue;
        let databaseBytes = 0;
        let databaseItems = 0;
        for (const member of members) {
            if (!take(budget)) break;
            const measured = await measureRoot(join(runtimeDirectory, member), budget);
            databaseBytes += measured.bytes;
            databaseItems += measured.items;
        }
        bytes += databaseBytes;
        items += databaseItems;
        count += 1;
        largest.add(database, databaseBytes);
    }
    return { bytes, items, count };
}

interface ListingOptions {
    readonly keyFor: (name: string, path: string) => string;
    readonly sessionPathFor?: (name: string, path: string, directory: boolean) => string | undefined;
}

async function measureListing(
    directory: string,
    budget: Budget,
    options: ListingOptions,
): Promise<{ totals: Totals; folders: number; largest: readonly StorageLargestItem[] }> {
    let handle;
    try {
        handle = await opendir(directory);
    } catch {
        return { totals: EMPTY_TOTALS, folders: 0, largest: [] };
    }
    const largest = new Largest();
    const totals = { bytes: 0, items: 0 };
    let folders = 0;
    try {
        for await (const entry of handle) {
            if (!take(budget)) break;
            const path = join(directory, entry.name);
            const visited = await visitEntry(path, budget, new Set());
            totals.bytes += visited.totals.bytes;
            totals.items += visited.totals.items;
            if (visited.directory) folders += 1;
            largest.add(
                options.keyFor(entry.name, path),
                visited.totals.bytes,
                options.sessionPathFor?.(entry.name, path, visited.directory),
            );
        }
    } catch {
    }
    return { totals, folders, largest: await largest.list() };
}

async function measureLogs(
    logDirectory: string,
    budget: Budget,
): Promise<StorageCategoryMeasurement> {
    const largest = new Largest();
    const totals = await walkLogs(logDirectory, logDirectory, budget, largest);
    return {
        category: "logs",
        bytes: totals.bytes,
        items: totals.items,
        summary: plural(totals.items, "log file", "log files"),
        largest: await largest.list(),
    };
}

async function walkLogs(
    directory: string,
    root: string,
    budget: Budget,
    largest: Largest,
): Promise<Totals> {
    let handle;
    try {
        handle = await opendir(directory);
    } catch {
        return EMPTY_TOTALS;
    }
    const totals = { bytes: 0, items: 0 };
    try {
        for await (const entry of handle) {
            const path = join(directory, entry.name);
            if (!take(budget)) break;
            const visited = await visitEntry(path, budget, new Set());
            totals.bytes += visited.totals.bytes;
            totals.items += visited.totals.items;
            if (!visited.directory) largest.add(displayPath(root, path), visited.totals.bytes);
        }
    } catch {
    }
    return totals;
}

function categoryRoots(home: string): readonly string[] {
    return [
        join(home, "runtime", "sessions"),
        join(home, "runtime", "scratch"),
        join(home, "runtime", "logs"),
        join(home, "runtime", "cache"),
        join(home, "machine", "cache"),
        join(home, "machine", "desktop", "chromium"),
        join(home, "extensions"),
        join(home, "extension-data"),
        join(home, "skills"),
        join(home, "agents"),
        join(home, "memory"),
    ].map((path) => resolve(path));
}

function isDatabaseName(name: string): boolean {
    return name === "inbox.db" || name === "schedules.db"
        || name.startsWith("inbox.db-") || name.startsWith("schedules.db-");
}

async function measureOther(
    home: string,
    budget: Budget,
    skip: ReadonlySet<string>,
): Promise<StorageCategoryMeasurement> {
    let handle;
    try {
        handle = await opendir(home);
    } catch {
        return { category: "other", bytes: 0, items: 0, summary: plural(0, "other file", "other files"), largest: [] };
    }
    const largest = new Largest();
    const totals = { bytes: 0, items: 0 };
    try {
        for await (const entry of handle) {
            const path = join(home, entry.name);
            if (skip.has(resolve(path))) continue;
            if (!take(budget)) break;
            const stats = await lstat(path).catch(() => undefined);
            if (stats === undefined) continue;
            if (stats.isDirectory() && (entry.name === "runtime" || entry.name === "machine")) {
                const inner = await measureContainer(path, budget, skip, largest);
                totals.bytes += inner.bytes;
                totals.items += inner.items;
                continue;
            }
            const visited = await visitEntry(path, budget, skip);
            totals.bytes += visited.totals.bytes;
            totals.items += visited.totals.items;
            largest.add(displayPath(home, path), visited.totals.bytes);
        }
    } catch {
    }
    return {
        category: "other",
        bytes: totals.bytes,
        items: totals.items,
        summary: plural(totals.items, "other file", "other files"),
        largest: await largest.list(),
    };
}

// runtime and machine also hold category roots, so their remaining children are
// the units, and each unit is measured without the roots it contains.
async function measureContainer(
    directory: string,
    budget: Budget,
    skip: ReadonlySet<string>,
    largest: Largest,
): Promise<Totals> {
    let handle;
    try {
        handle = await opendir(directory);
    } catch {
        return EMPTY_TOTALS;
    }
    const totals = { bytes: 0, items: 0 };
    try {
        for await (const entry of handle) {
            if (isDatabaseName(entry.name)) continue;
            const path = join(directory, entry.name);
            if (skip.has(resolve(path))) continue;
            if (!take(budget)) break;
            const visited = await visitEntry(path, budget, skip);
            totals.bytes += visited.totals.bytes;
            totals.items += visited.totals.items;
            largest.add(displayPath(directory, path), visited.totals.bytes);
        }
    } catch {
    }
    return totals;
}

async function measureOldScratch(
    sessionDirectory: string,
    tempRoot: string,
    budget: Budget,
): Promise<StorageCategoryMeasurement> {
    let handle;
    try {
        handle = await opendir(tempRoot);
    } catch {
        return {
            category: "old_scratch",
            bytes: 0,
            items: 0,
            summary: plural(0, "temporary session folder", "temporary session folders"),
            largest: [],
        };
    }
    const largest = new Largest();
    let bytes = 0;
    let items = 0;
    let folders = 0;
    try {
        for await (const entry of handle) {
            if (!take(budget)) break;
            if (!safeSessionName(entry.name)) continue;
            const sessionPath = join(sessionDirectory, `${entry.name}.jsonl`);
            const sessionStats = await lstat(sessionPath).catch(() => undefined);
            if (sessionStats?.isFile() !== true) continue;
            const path = join(tempRoot, entry.name);
            const stats = await lstat(path).catch(() => undefined);
            if (stats?.isDirectory() !== true) continue;
            const measured = await visitEntry(path, budget, new Set());
            bytes += measured.totals.bytes;
            items += measured.totals.items;
            folders += 1;
            largest.add(entry.name, measured.totals.bytes, sessionPath);
        }
    } catch {
    }
    return {
        category: "old_scratch",
        bytes,
        items,
        summary: plural(folders, "temporary session folder", "temporary session folders"),
        largest: await largest.list(),
    };
}

export function safeSessionName(name: string): boolean {
    return name.length > 0
        && name !== "."
        && name !== ".."
        && basename(name) === name
        && !name.includes("/")
        && !name.includes("\\")
        && !name.includes("\0");
}

function scratchPath(options: StorageMeasureOptions): string {
    try {
        return typeof options.scratchDirectory === "function"
            ? options.scratchDirectory()
            : options.scratchDirectory;
    } catch {
        return join(options.home, "runtime", "scratch");
    }
}

async function measureNow(options: StorageMeasureOptions): Promise<StorageMeasurement> {
    const budget: Budget = {
        remaining: options.entryLimit ?? STORAGE_MEASURE_ENTRY_LIMIT,
        partial: false,
    };
    const home = resolve(options.home);
    const skip = new Set(categoryRoots(home));

    const sessions = await measureSessions(options.sessionDirectory, join(home, "runtime"), budget);
    const scratch = await measureListing(scratchPath(options), budget, {
        keyFor: (name) => name,
        sessionPathFor: (name, _path, directory) => directory
            ? join(options.sessionDirectory, `${name}.jsonl`)
            : undefined,
    });
    const logs = await measureLogs(options.logDirectory, budget);

    const cacheTotals = { bytes: 0, items: 0 };
    const cacheLargest = new Largest();
    for (const root of [join(home, "runtime", "cache"), join(home, "machine", "cache")]) {
        const listing = await measureListing(root, budget, {
            keyFor: (name, path) => displayPath(home, path),
        });
        cacheTotals.bytes += listing.totals.bytes;
        cacheTotals.items += listing.totals.items;
        await cacheLargest.merged(listing.largest);
    }

    const extensionTotals = { bytes: 0, items: 0 };
    const extensionLargest = new Largest();
    for (const root of ["extensions", "extension-data", "skills", "agents", "memory"]) {
        const listing = await measureListing(join(home, root), budget, {
            keyFor: (name) => `${root}/${name}`,
        });
        extensionTotals.bytes += listing.totals.bytes;
        extensionTotals.items += listing.totals.items;
        await extensionLargest.merged(listing.largest);
    }

    const browser = await measureListing(join(home, "machine", "desktop", "chromium"), budget, {
        keyFor: (name) => `chromium/${name}`,
    });
    const other = await measureOther(home, budget, skip);

    const categories: StorageCategoryMeasurement[] = [
        sessions,
        {
            category: "scratch",
            bytes: scratch.totals.bytes,
            items: scratch.totals.items,
            summary: plural(scratch.folders, "session folder", "session folders"),
            largest: scratch.largest,
        },
        logs,
        {
            category: "caches",
            bytes: cacheTotals.bytes,
            items: cacheTotals.items,
            summary: plural(cacheTotals.items, "cache file", "cache files"),
            largest: await cacheLargest.list(),
        },
        {
            category: "extensions",
            bytes: extensionTotals.bytes,
            items: extensionTotals.items,
            summary: plural(extensionTotals.items, "file", "files"),
            largest: await extensionLargest.list(),
        },
        {
            category: "browser",
            bytes: browser.totals.bytes,
            items: browser.totals.items,
            summary: plural(browser.totals.items, "browser data file", "browser data files"),
            largest: browser.largest,
        },
        other,
    ];
    const total = categories.reduce((sum, category) => sum + category.bytes, 0);
    const oldScratch = await measureOldScratch(
        options.sessionDirectory,
        options.tempRoot ?? join(tmpdir(), "vera"),
        budget,
    );
    return {
        categories,
        total_bytes: total,
        measured_at: (options.now ?? (() => new Date()))().toISOString(),
        partial: budget.partial,
        old_scratch: oldScratch,
    };
}

export function createStorageMeasurer(options: StorageMeasureOptions): StorageMeasurer {
    let last: StorageMeasurement | undefined;
    let running: Promise<StorageMeasurement> | undefined;
    return {
        measure(refresh: boolean): Promise<StorageMeasurement> {
            if (running !== undefined) return running;
            if (!refresh && last !== undefined) return Promise.resolve(last);
            const pending = measureNow(options)
                .then((measurement) => {
                    last = measurement;
                    return measurement;
                })
                .finally(() => {
                    if (running === pending) running = undefined;
                });
            running = pending;
            return pending;
        },
    };
}

export interface StoragePathSize {
    readonly bytes: number;
    readonly items: number;
}

export interface StorageWalk {
    measure(path: string): Promise<StoragePathSize>;
    readonly partial: boolean;
}

// A shared entry budget for measuring several paths in one preview.
export function createStorageWalk(entryLimit: number = STORAGE_MEASURE_ENTRY_LIMIT): StorageWalk {
    const budget: Budget = { remaining: entryLimit, partial: false };
    return {
        measure: (path) => measureRoot(path, budget),
        get partial() { return budget.partial; },
    };
}
