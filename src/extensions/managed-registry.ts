import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { VeraExtensionConfig } from "../config.ts";

export const EXTENSION_REGISTRY_SCHEMA_VERSION = 1;
export const MANAGED_STATE_DIRECTORY = ".managed";
const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export interface ManagedExtensionSource {
    readonly kind: "local";
    readonly path: string;
}

export interface ManagedExtensionRecord {
    readonly id: string;
    readonly version: string;
    readonly source: ManagedExtensionSource;
    readonly digest: string;
    readonly directory: string;
    readonly enabled: boolean;
    readonly installedAt: string;
}

export interface ExtensionRegistryDocument {
    readonly schema_version: typeof EXTENSION_REGISTRY_SCHEMA_VERSION;
    readonly extensions: readonly ManagedExtensionRecord[];
}

export class ExtensionManagerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExtensionManagerError";
    }
}

export function assertSafeExtensionDirectory(directory: string): void {
    const resolvedDirectory = resolve(directory);
    const scopeRoot = dirname(resolvedDirectory);
    for (const path of [scopeRoot, resolvedDirectory]) {
        try {
            if (lstatSync(path).isSymbolicLink()) {
                throw new ExtensionManagerError(
                    `Extension directory boundary is a symlink: ${path}`,
                );
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
        }
    }
    const registryPath = join(scopeRoot, "extensions.json");
    try {
        if (lstatSync(registryPath).isSymbolicLink()) {
            throw new ExtensionManagerError(
                `Extension registry is a symlink: ${registryPath}`,
            );
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

export function readExtensionRegistry(
    directory: string,
    registryPath = join(dirname(directory), "extensions.json"),
): ExtensionRegistryDocument {
    assertSafeExtensionDirectory(directory);
    let source: string;
    try {
        source = readFileSync(registryPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return emptyRegistry();
        }
        throw new ExtensionManagerError(
            `Could not read extension registry at ${registryPath}: ${errorMessage(error)}`,
        );
    }

    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch (error) {
        throw new ExtensionManagerError(
            `Extension registry at ${registryPath} is not valid JSON: ${errorMessage(error)}`,
        );
    }
    const parsed = parseRegistry(value);
    if (parsed === undefined) {
        throw new ExtensionManagerError(
            `Extension registry at ${registryPath} has an invalid shape`,
        );
    }
    return parsed;
}

export function managedExtensionConfigs(
    directory: string,
    registryPath = join(dirname(directory), "extensions.json"),
): readonly VeraExtensionConfig[] {
    return readManagedExtensionRecords(directory, registryPath)
        .filter((record) => isManagedDirectoryPresent(extensionPath(directory, record)))
        .map((record) => ({
            path: extensionPath(directory, record),
            enabled: record.enabled,
            config: {},
        }));
}

export function parseRegistry(value: unknown): ExtensionRegistryDocument | undefined {
    if (!isRecord(value) || value.schema_version !== EXTENSION_REGISTRY_SCHEMA_VERSION) {
        return undefined;
    }
    if (!Array.isArray(value.extensions)) return undefined;
    const extensions: ManagedExtensionRecord[] = [];
    for (const item of value.extensions) {
        const record = parseManagedRecord(item);
        if (record === undefined) return undefined;
        if (extensions.some((entry) => entry.id === record.id)) return undefined;
        extensions.push(record);
    }
    return { schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION, extensions };
}

function parseManagedRecord(value: unknown): ManagedExtensionRecord | undefined {
    if (!isRecord(value)) return undefined;
    const source = isRecord(value.source) ? value.source : undefined;
    if (
        typeof value.id !== "string"
        || !EXTENSION_ID_PATTERN.test(value.id)
        || typeof value.version !== "string"
        || value.version.trim().length === 0
        || typeof value.digest !== "string"
        || !/^sha256:[0-9a-f]{64}$/.test(value.digest)
        || typeof value.directory !== "string"
        || value.directory !== managedExtensionDirectory(value.id)
        || typeof value.enabled !== "boolean"
        || typeof value.installedAt !== "string"
        || Number.isNaN(Date.parse(value.installedAt))
        || source === undefined
        || source.kind !== "local"
        || typeof source.path !== "string"
        || !isAbsolute(source.path)
    ) {
        return undefined;
    }
    return {
        id: value.id,
        version: value.version,
        source: { kind: "local", path: source.path },
        digest: value.digest,
        directory: value.directory,
        enabled: value.enabled,
        installedAt: value.installedAt,
    };
}

export function readManagedExtensionRecords(
    directory: string,
    registryPath: string,
): readonly ManagedExtensionRecord[] {
    assertSafeExtensionDirectory(directory);
    const centralExists = fileExists(registryPath);
    const central = centralExists
        ? readExtensionRegistry(directory, registryPath).extensions
        : [];
    const markers = readManagedMarkers(directory);
    const markerById = new Map(markers.map((record) => [record.id, record]));
    const records = central.map((record) => {
        const marker = markerById.get(record.id);
        if (marker === undefined) {
            // Backfill the crash-safe marker for registries written by the first manager version.
            writeManagedMarker(directory, record);
            return record;
        }
        if (marker.directory !== record.directory || marker.source.path !== record.source.path) {
            throw new ExtensionManagerError(
                `Managed state for ${record.id} disagrees with the extension registry`,
            );
        }
        markerById.delete(record.id);
        return { ...record, enabled: marker.enabled };
    });
    return [...records, ...markerById.values()].toSorted((left, right) =>
        left.id.localeCompare(right.id)
    );
}

function readManagedMarkers(directory: string): readonly ManagedExtensionRecord[] {
    const stateDirectory = join(directory, MANAGED_STATE_DIRECTORY);
    let children: readonly string[];
    try {
        if (lstatSync(stateDirectory).isSymbolicLink()) {
            throw new ExtensionManagerError(
                `Managed extension state directory is a symlink: ${stateDirectory}`,
            );
        }
        children = readdirSync(stateDirectory).toSorted();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const records: ManagedExtensionRecord[] = [];
    for (const child of children) {
        if (child.endsWith(".tmp")) {
            rmSync(join(stateDirectory, child), { force: true });
            continue;
        }
        if (!child.endsWith(".json")) {
            throw new ExtensionManagerError(
                `Unexpected file in managed extension state directory: ${child}`,
            );
        }
        const path = join(stateDirectory, child);
        if (lstatSync(path).isSymbolicLink()) {
            throw new ExtensionManagerError(`Managed extension state is a symlink: ${path}`);
        }
        let value: unknown;
        try {
            value = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
            throw new ExtensionManagerError(
                `Managed extension state at ${path} is invalid: ${errorMessage(error)}`,
            );
        }
        const record = parseManagedRecord(value);
        if (record === undefined || child !== `${record.id}.json`) {
            throw new ExtensionManagerError(
                `Managed extension state at ${path} has an invalid shape`,
            );
        }
        if (records.some((entry) => entry.id === record.id)) {
            throw new ExtensionManagerError(`Duplicate managed state for ${record.id}`);
        }
        records.push(record);
    }
    return records;
}

export function writeManagedMarker(directory: string, record: ManagedExtensionRecord): void {
    assertSafeExtensionDirectory(directory);
    const stateDirectory = join(directory, MANAGED_STATE_DIRECTORY);
    try {
        if (lstatSync(stateDirectory).isSymbolicLink()) {
            throw new ExtensionManagerError(
                `Managed extension state directory is a symlink: ${stateDirectory}`,
            );
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, `${record.id}.json`);
    try {
        if (lstatSync(path).isSymbolicLink()) {
            throw new ExtensionManagerError(`Managed extension state is a symlink: ${path}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        renameSync(temporary, path);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
}

export function assertManagedPathSafe(path: string): void {
    try {
        if (lstatSync(path).isSymbolicLink()) {
            throw new ExtensionManagerError(`Managed extension path is a symlink: ${path}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

export function isManagedDirectoryPresent(path: string): boolean {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
            throw new ExtensionManagerError(`Managed extension path is a symlink: ${path}`);
        }
        return stat.isDirectory();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export function managedExtensionDirectory(id: string): string {
    return join("extensions", id);
}

export function extensionPath(
    directory: string,
    record: Pick<ManagedExtensionRecord, "directory">,
): string {
    return join(dirname(directory), record.directory);
}

function emptyRegistry(): ExtensionRegistryDocument {
    return {
        schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
        extensions: [],
    };
}

export function fileExists(path: string): boolean {
    try {
        return lstatSync(path).isFile();
    } catch {
        return false;
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
