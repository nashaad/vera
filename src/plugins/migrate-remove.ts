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

import { assertSafeExtensionDirectory, parseRegistry } from "../extensions/managed-registry.ts";
import { loadExtensionManifest } from "../extensions/manifest.ts";
import { withFileLock } from "../store/managed-directory.ts";
import { legacyStores } from "./migrate-legacy.ts";
import { legacyStoreWasMigrated } from "./migrate-startup.ts";
import { loadDesktopExtension } from "./extension-parts.ts";
import { MAX_PLUGINS, type PluginRecord } from "./registry.ts";

interface FileUpdate {
    readonly path: string;
    readonly before: string;
    readonly after: string;
    readonly mode: number;
}

interface Move {
    readonly original: string;
    readonly temporary: string;
}

export function withMigratedLegacyRemoval<T>(
    home: string,
    record: PluginRecord,
    action: (removedPaths: readonly string[]) => T,
): T {
    if (record.source.kind !== "migration") return action([]);
    const stores = legacyStores(home);
    for (const path of [home, dirname(stores.desktopDirectory), dirname(dirname(stores.desktopDirectory))]) {
        assertNotSymlink(path);
    }
    const hostActive = !legacyStoreWasMigrated(stores.hostDirectory);
    const desktopActive = !legacyStoreWasMigrated(stores.desktopDirectory);
    if (hostActive) assertSafeExtensionDirectory(stores.hostDirectory);
    if (desktopActive) {
        assertNotSymlink(stores.desktopDirectory);
        assertNotSymlink(stores.desktopState);
    }
    if (![...(hostActive ? [stores.hostDirectory, stores.hostState] : []),
        ...(desktopActive ? [stores.desktopDirectory, stores.desktopState] : [])].some(exists)) {
        return action([]);
    }
    return withFileLock(`${stores.hostState}.lock`, () => {
        const moves: Move[] = [];
        const updates: FileUpdate[] = [];
        const removed: string[] = [];
        const hostId = record.components.host_extension;
        const desktopId = record.components.desktop_extension;
        if (hostActive && hostId !== null) {
            assertId(hostId);
            const hostPaths = findHostPaths(stores.hostDirectory, hostId);
            if (hostPaths.length > 1) throw new Error(`Multiple legacy host extensions have id ${hostId}`);
            const source = resolve(record.source.path);
            const sourcePart = relative(resolve(stores.hostDirectory), source);
            if (sourcePart !== "" && sourcePart !== ".." && !sourcePart.startsWith(`..${sep}`)
                && !isAbsolute(sourcePart) && exists(source) && !hostPaths.some((path) => resolve(path) === source)) {
                throw new Error(`Cannot verify legacy host extension: ${source}`);
            }
            for (const path of hostPaths) {
                moves.push(moveFor(path));
                removed.push(path);
            }
            const markerDirectory = join(stores.hostDirectory, ".managed");
            assertNotSymlink(markerDirectory);
            const marker = join(markerDirectory, `${hostId}.json`);
            assertNotSymlink(marker);
            if (exists(marker)) {
                const state = readState(marker, 256 * 1024);
                const parsed = state === undefined ? undefined : parseRegistry({ schema_version: 1, extensions: [state.value] });
                if (parsed?.extensions[0]?.id !== hostId) throw new Error(`Invalid legacy extension marker: ${marker}`);
                moves.push(moveFor(marker));
            }
            const hostState = readState(stores.hostState, 256 * 1024);
            if (hostState !== undefined) {
                const parsed = parseRegistry(hostState.value);
                if (parsed === undefined) throw new Error(`Invalid legacy extension registry: ${stores.hostState}`);
                const extensions = parsed.extensions.filter((entry) => entry.id !== hostId);
                if (extensions.length !== parsed.extensions.length) {
                    updates.push({ ...hostState, after: `${JSON.stringify({ ...hostState.value, extensions }, null, 2)}\n` });
                }
            }
        }
        if (desktopActive && desktopId !== null) {
            assertId(desktopId);
            const desktop = join(stores.desktopDirectory, desktopId);
            assertNotSymlink(desktop);
            const details = statOrUndefined(desktop);
            if (details !== undefined) {
                if (!details.isDirectory()) throw new Error(`Legacy desktop extension is not a directory: ${desktop}`);
                const warnings: string[] = [];
                const part = loadDesktopExtension(desktop, realpathSync(desktop), warnings, true);
                if (part?.id !== desktopId) throw new Error(`Cannot verify legacy desktop extension: ${desktop}`);
                moves.push(moveFor(desktop));
                removed.push(desktop);
            }
            const desktopState = readState(stores.desktopState, 64 * 1024);
            if (desktopState !== undefined) {
                const { version, disabled } = desktopState.value;
                if (version !== 1 || !Array.isArray(disabled) || disabled.some((id: unknown) => typeof id !== "string")) {
                    throw new Error(`Invalid legacy desktop extension state: ${stores.desktopState}`);
                }
                const remaining = disabled.filter((id: string) => id !== desktopId);
                if (remaining.length !== disabled.length) {
                    updates.push({ ...desktopState, after: `${JSON.stringify({ ...desktopState.value, disabled: remaining }, null, 2)}\n` });
                }
            }
        }
        const moved: Move[] = [];
        const written: FileUpdate[] = [];
        let result: T;
        try {
            for (const move of moves) {
                renameSync(move.original, move.temporary);
                moved.push(move);
            }
            for (const update of updates) {
                replaceState(update.path, update.before, update.after, update.mode);
                written.push(update);
            }
            result = action(removed);
        } catch (error) {
            const failures: string[] = [];
            for (const update of written.toReversed()) {
                try { replaceState(update.path, update.after, update.before, update.mode); }
                catch (rollback) { failures.push(errorMessage(rollback)); }
            }
            for (const move of moved.toReversed()) {
                try { renameSync(move.temporary, move.original); }
                catch (rollback) { failures.push(errorMessage(rollback)); }
            }
            if (failures.length > 0) throw new Error(`${errorMessage(error)}; legacy rollback failed: ${failures.join("; ")}`);
            throw error;
        }
        for (const move of moved) {
            try { rmSync(move.temporary, { recursive: true, force: true }); }
            catch (error) {
                throw new Error(`Plugin ${record.name} was removed, but ${move.temporary} could not be deleted: ${errorMessage(error)}`);
            }
        }
        return result;
    });
}

function findHostPaths(directory: string, id: string): string[] {
    const details = statOrUndefined(directory);
    if (details === undefined) return [];
    if (!details.isDirectory()) throw new Error(`Legacy extensions path is not a directory: ${directory}`);
    const stream = opendirSync(directory);
    const matches: string[] = [];
    let count = 0;
    try {
        for (let entry = stream.readSync(); entry !== null; entry = stream.readSync()) {
            if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
            if (++count > MAX_PLUGINS) throw new Error(`More than ${MAX_PLUGINS} legacy extensions in ${directory}`);
            const path = join(directory, entry.name);
            try {
                if (loadExtensionManifest(path).manifest.id === id) matches.push(path);
            } catch {
            }
        }
    } finally {
        stream.closeSync();
    }
    return matches;
}

function readState(path: string, limit: number):
    { readonly path: string; readonly before: string; readonly mode: number; readonly value: Record<string, unknown> } | undefined {
    assertNotSymlink(path);
    const details = statOrUndefined(path);
    if (details === undefined) return undefined;
    if (!details.isFile() || details.size > limit) throw new Error(`Invalid legacy extension state: ${path}`);
    const before = readFileSync(path, "utf8");
    const value: unknown = JSON.parse(before);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Invalid legacy extension state: ${path}`);
    }
    return { path, before, mode: details.mode & 0o777, value: value as Record<string, unknown> };
}

function replaceState(path: string, expected: string, next: string, mode: number): void {
    if (readFileSync(path, "utf8") !== expected) throw new Error(`Legacy extension state changed: ${path}`);
    const temporary = `${path}.plugins-${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, next, { flag: "wx", mode });
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

function moveFor(original: string): Move {
    return { original, temporary: join(dirname(original), `.removing-plugin-${randomUUID()}`) };
}

function assertId(id: string): void {
    if (!/^[a-z0-9-][a-z0-9._-]*$/.test(id) || id.includes("..")) {
        throw new Error(`Invalid legacy extension id: ${id}`);
    }
}

function statOrUndefined(path: string): Stats | undefined {
    try { return lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function exists(path: string): boolean { return statOrUndefined(path) !== undefined; }
function assertNotSymlink(path: string): void {
    if (statOrUndefined(path)?.isSymbolicLink()) throw new Error(`Legacy extension path is a symlink: ${path}`);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
