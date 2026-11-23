import { randomUUID } from "node:crypto";
import {
    lstatSync,
    opendirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
    type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { readManagedExtensionRecords } from "../extensions/managed-registry.ts";
import { loadExtensionManifest } from "../extensions/manifest.ts";
import { loadDesktopExtension } from "./extension-parts.ts";
import { MAX_PLUGINS } from "./registry.ts";

export interface LegacyPart {
    readonly kind: "host" | "desktop";
    readonly id: string;
    readonly path: string;
    readonly enabled: boolean;
}

export interface LegacyStores {
    readonly hostDirectory: string;
    readonly hostState: string;
    readonly desktopDirectory: string;
    readonly desktopState: string;
    readonly configPath: string;
}

export interface LegacyStoreSelection {
    readonly host: boolean;
    readonly desktop: boolean;
}

export interface LegacyConfig {
    readonly text: string;
    readonly value: Record<string, unknown>;
    readonly mode: number;
}

export function legacyStores(home: string): LegacyStores {
    return {
        hostDirectory: join(home, "extensions"),
        hostState: join(home, "extensions.json"),
        desktopDirectory: join(home, "machine", "desktop", "extensions"),
        desktopState: join(home, "machine", "desktop", "extensions.json"),
        configPath: join(home, "config.json"),
    };
}

export function readLegacyConfig(path: string): LegacyConfig | undefined {
    const details = existing(path);
    if (details === undefined) return undefined;
    if (!details.isFile() || details.isSymbolicLink() || details.size > 4 * 1024 * 1024) {
        throw new Error(`Cannot read config at ${path}: expected a regular file of at most 4 MiB`);
    }
    const text = readFileSync(path, "utf8");
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || (value.extensions !== undefined && !Array.isArray(value.extensions))) {
        throw new Error(`Cannot migrate extensions from invalid config at ${path}`);
    }
    return { text, value, mode: details.mode & 0o777 };
}

export function collectLegacyParts(
    stores: LegacyStores,
    config: LegacyConfig | undefined,
    failures: string[],
    selected: LegacyStoreSelection,
): LegacyPart[] {
    assertSafeLegacyStores(stores, selected);
    const parts: LegacyPart[] = [];
    if (selected.host) {
        const records = readManagedExtensionRecords(stores.hostDirectory, stores.hostState);
        const managedByPath = new Map(records.map((record) => [
            resolve(stores.hostDirectory, record.id), record,
        ]));
        const seenManaged = new Set<string>();
        for (const path of children(stores.hostDirectory)) {
            try {
                if (!lstatSync(path).isDirectory()) throw new Error("source is not a directory");
                const manifest = loadExtensionManifest(path).manifest;
                const record = managedByPath.get(resolve(path));
                if (record !== undefined) {
                    if (record.id !== manifest.id) throw new Error("managed id does not match the manifest");
                    seenManaged.add(record.id);
                }
                const configured = configuredExtension(config, path);
                parts.push({
                    kind: "host",
                    id: manifest.id,
                    path,
                    enabled: record?.enabled ?? configured?.enabled ?? true,
                });
            } catch (error) {
                failures.push(`host ${path}: ${errorMessage(error)}`);
            }
        }
        for (const record of records) {
            if (!seenManaged.has(record.id)) {
                failures.push(`host ${record.id}: managed extension is missing or unreadable`);
            }
        }
    }

    if (selected.desktop) {
        const disabled = desktopDisabled(stores.desktopState);
        for (const path of children(stores.desktopDirectory)) {
            try {
                if (!lstatSync(path).isDirectory()) throw new Error("source is not a directory");
                const warnings: string[] = [];
                const part = loadDesktopExtension(path, realpathSync(path), warnings, true);
                if (part === undefined) throw new Error(warnings.join("; ") || "invalid desktop extension");
                if (resolve(stores.desktopDirectory, part.id) !== resolve(path)) {
                    throw new Error(`folder name does not match id ${part.id}`);
                }
                parts.push({ kind: "desktop", id: part.id, path, enabled: !disabled.has(part.id) });
            } catch (error) {
                failures.push(`desktop ${path}: ${errorMessage(error)}`);
            }
        }
    }
    return parts;
}

export function rewriteLegacyConfig(
    stores: LegacyStores,
    config: LegacyConfig | undefined,
    destinations: ReadonlyMap<string, string>,
): { readonly changed: boolean; readonly unresolved: readonly string[] } {
    if (config === undefined || !Array.isArray(config.value.extensions)) {
        return { changed: false, unresolved: [] };
    }
    let changed = false;
    const unresolved: string[] = [];
    const extensions = config.value.extensions.map((entry: unknown) => {
        if (!isRecord(entry) || typeof entry.path !== "string" || !isAbsolute(entry.path)) return entry;
        const oldPath = resolve(entry.path);
        if (!isWithin(stores.hostDirectory, oldPath)) return entry;
        const matching = [...destinations.entries()].find(([source]) => isWithin(source, oldPath));
        if (matching === undefined) {
            unresolved.push(`No migrated plugin for configured extension ${entry.path}`);
            return entry;
        }
        changed = true;
        return { ...entry, path: join(matching[1], relative(matching[0], oldPath)) };
    });
    if (!changed) return { changed: false, unresolved };
    if (readFileSync(stores.configPath, "utf8") !== config.text) {
        throw new Error(`Config changed during migration: ${stores.configPath}`);
    }
    const temporary = `${stores.configPath}.plugins-${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify({ ...config.value, extensions }, null, 2)}\n`, {
            mode: config.mode,
            flag: "wx",
        });
        renameSync(temporary, stores.configPath);
    } finally {
        rmSync(temporary, { force: true });
    }
    return { changed: true, unresolved };
}

export function renameLegacyStores(stores: LegacyStores, selected: LegacyStoreSelection): string[] {
    assertSafeLegacyStores(stores, selected);
    const moves = [
        ...(selected.host ? [
            [stores.hostDirectory, join(stores.hostDirectory, "..", "extensions.pre-plugins")],
            [stores.hostState, join(stores.hostState, "..", "extensions.pre-plugins.json")],
        ] : []),
        ...(selected.desktop ? [
            [stores.desktopDirectory, join(stores.desktopDirectory, "..", "extensions.pre-plugins")],
            [stores.desktopState, join(stores.desktopState, "..", "extensions.pre-plugins.json")],
        ] : []),
    ].filter(([source]) => existing(source!) !== undefined);
    for (const [, destination] of moves) {
        if (existing(destination!) !== undefined) {
            throw new Error(`Rollback copy already exists: ${destination}. Move it aside to let migration finish.`);
        }
    }
    const moved: string[][] = [];
    try {
        for (const [source, destination] of moves) {
            renameSync(source!, destination!);
            moved.push([source!, destination!]);
        }
    } catch (error) {
        const undoFailures: string[] = [];
        for (const [source, destination] of moved.toReversed()) {
            try { renameSync(destination!, source!); } catch (undo) { undoFailures.push(errorMessage(undo)); }
        }
        if (undoFailures.length > 0) throw new Error(`${errorMessage(error)}; rollback: ${undoFailures.join("; ")}`);
        throw error;
    }
    return moved.map(([, destination]) => destination!);
}


export function assertSafeLegacyBoundaries(stores: LegacyStores): void {
    const home = dirname(stores.hostDirectory);
    const machine = join(home, "machine");
    const desktop = dirname(stores.desktopDirectory);
    for (const path of [home, machine, desktop]) {
        if (existing(path)?.isSymbolicLink()) throw new Error(`Legacy extension path is a symlink: ${path}`);
    }
}

function assertSafeLegacyStores(stores: LegacyStores, selected: LegacyStoreSelection): void {
    assertSafeLegacyBoundaries(stores);
    const paths = [
        ...(selected.host ? [stores.hostDirectory, stores.hostState] : []),
        ...(selected.desktop ? [stores.desktopDirectory, stores.desktopState] : []),
    ];
    for (const path of paths) {
        if (existing(path)?.isSymbolicLink()) throw new Error(`Legacy extension path is a symlink: ${path}`);
    }
}

function configuredExtension(config: LegacyConfig | undefined, path: string): { enabled: boolean } | undefined {
    const entries = config?.value.extensions;
    if (!Array.isArray(entries)) return undefined;
    const found = entries.find((entry: unknown) =>
        isRecord(entry) && typeof entry.path === "string" && isAbsolute(entry.path)
        && resolve(entry.path) === resolve(path)
    );
    return isRecord(found) ? { enabled: found.enabled !== false } : undefined;
}

function desktopDisabled(path: string): ReadonlySet<string> {
    const details = existing(path);
    if (details === undefined) return new Set();
    if (!details.isFile() || details.isSymbolicLink() || details.size > 64 * 1024) {
        throw new Error(`Cannot read desktop extension state at ${path}`);
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.disabled)
        || value.disabled.some((id: unknown) => typeof id !== "string")) {
        throw new Error(`Invalid desktop extension state at ${path}`);
    }
    return new Set(value.disabled as string[]);
}

function children(directory: string): string[] {
    const details = existing(directory);
    if (details === undefined) return [];
    if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error(`Legacy extensions directory is not a directory: ${directory}`);
    }
    const stream = opendirSync(directory);
    const paths: string[] = [];
    try {
        for (let entry = stream.readSync(); entry !== null; entry = stream.readSync()) {
            if (entry.name.startsWith(".")) continue;
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            paths.push(join(directory, entry.name));
            if (paths.length > MAX_PLUGINS) throw new Error(`More than ${MAX_PLUGINS} legacy extensions in ${directory}`);
        }
    } finally {
        stream.closeSync();
    }
    return paths.toSorted();
}

function existing(path: string): Stats | undefined {
    try { return lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function isWithin(directory: string, path: string): boolean {
    const part = relative(resolve(directory), path);
    return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
