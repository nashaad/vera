import {
    EXTENSION_REGISTRY_SCHEMA_VERSION, MANAGED_STATE_DIRECTORY, ExtensionManagerError,
    assertSafeExtensionDirectory,
    parseRegistry, readManagedExtensionRecords, writeManagedMarker,
    assertManagedPathSafe, isManagedDirectoryPresent, managedExtensionDirectory,
    extensionPath, fileExists, isRecord, errorMessage,
    type ManagedExtensionRecord, type ExtensionRegistryDocument,
} from "./managed-registry.ts";
export {
    EXTENSION_REGISTRY_SCHEMA_VERSION, ExtensionManagerError, assertSafeExtensionDirectory,
    readExtensionRegistry, managedExtensionConfigs,
} from "./managed-registry.ts";
export type { ManagedExtensionSource, ManagedExtensionRecord, ExtensionRegistryDocument } from "./managed-registry.ts";
import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    cpSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
    updateVeraConfigDefaults,
    type LoadVeraConfigOptions,
    type VeraExtensionConfig,
} from "../config.ts";
import { includedExtensionIds } from "./included.ts";
import { loadExtensionManifest } from "./manifest.ts";
import { installedExtensionIdsIn, veraProfileDirectory } from "../profile-paths.ts";

export interface ExtensionInstallPreview {
    readonly id: string;
    readonly version: string;
    readonly source: string;
    readonly destination: string;
    readonly digest: string;
    readonly capabilities: readonly string[];
    readonly unreviewedTools: readonly string[];
    readonly dryRun: boolean;
}

export interface ExtensionInstallResult {
    readonly preview: ExtensionInstallPreview;
    readonly record?: ManagedExtensionRecord;
}

export interface ExtensionListEntry {
    readonly included?: boolean;
    readonly core?: boolean;
    readonly id: string;
    readonly version?: string;
    readonly enabled: boolean;
    readonly managed: boolean;
    readonly path: string;
    readonly source?: string;
    readonly digest?: string;
    readonly capabilities?: readonly string[];
    readonly error?: string;
}

export interface ExtensionManagerOptions {
    readonly home?: string;
}

export interface ExtensionManagerOperations {
    readonly install: typeof installExtension;
    readonly list: typeof listExtensions;
    readonly setEnabled: typeof setAnyExtensionEnabled;
    readonly remove: typeof removeExtension;
}

export function extensionDirectoryFor(
    options: ExtensionManagerOptions = {},
): string {
    return join(veraProfileDirectory(process.env, options.home), "extensions");
}

export function extensionRegistryPathFor(
    options: ExtensionManagerOptions = {},
): string {
    return join(dirname(extensionDirectoryFor(options)), "extensions.json");
}

export function installExtension(
    source: string,
    options: ExtensionManagerOptions & { readonly dryRun?: boolean } = {},
): ExtensionInstallResult {
    const directory = extensionDirectoryFor(options);
    const registryPath = extensionRegistryPathFor(options);
    assertSafeExtensionDirectory(directory);
    const sourcePath = resolve(source);

    if (options.dryRun === true) {
        const prepared = stableSource(sourcePath);
        const records = readManagedExtensionRecords(directory, registryPath);
        assertInstallSlot(directory, prepared.loaded.manifest.id, records);
        return {
            preview: installPreview(directory, sourcePath, prepared, true),
        };
    }

    return withRegistryLock(registryPath, () => {
        assertSafeExtensionDirectory(directory);
        const prepared = stableSource(sourcePath);
        const records = readManagedExtensionRecords(directory, registryPath);
        const activeRecords = repairMissingRecords(directory, registryPath, records);
        assertInstallSlot(
            directory,
            prepared.loaded.manifest.id,
            activeRecords,
        );

        const staging = join(
            directory,
            `.staging-${prepared.loaded.manifest.id}-${process.pid}-${randomUUID()}`,
        );
        const destination = join(directory, prepared.loaded.manifest.id);
        let markerWritten = false;
        let registryWritten = false;
        let moved = false;
        let record: ManagedExtensionRecord | undefined;
        try {
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            cpSync(prepared.loaded.directory, staging, {
                recursive: true,
                errorOnExist: true,
                force: false,
            });
            const staged = loadExtensionManifest(staging);
            const stagedDigest = digestExtensionDirectory(staged.directory);
            const currentSource = stableSource(sourcePath);
            if (
                staged.manifest.id !== currentSource.loaded.manifest.id
                || stagedDigest !== currentSource.digest
            ) {
                throw new ExtensionManagerError(
                    `Extension ${prepared.loaded.manifest.id} changed while it was being staged`,
                );
            }
            record = {
                id: staged.manifest.id,
                version: staged.manifest.version,
                source: { kind: "local", path: sourcePath },
                digest: stagedDigest,
                directory: managedExtensionDirectory(staged.manifest.id),
                enabled: true,
                installedAt: new Date().toISOString(),
            };
            writeManagedMarker(directory, record);
            markerWritten = true;
            writeExtensionRegistry(directory, registryPath, {
                schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
                extensions: [...activeRecords, record],
            });
            registryWritten = true;
            renameSync(staging, destination);
            moved = true;
        } catch (error) {
            if (moved) rmSync(destination, { recursive: true, force: true });
            if (registryWritten) {
                try {
                    writeExtensionRegistry(directory, registryPath, {
                        schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
                        extensions: activeRecords,
                    });
                } catch {
                }
            }
            if (markerWritten) {
                try {
                    removeManagedMarker(directory, record!.id);
                } catch {
                }
            }
            rmSync(staging, { recursive: true, force: true });
            if (error instanceof ExtensionManagerError) throw error;
            throw new ExtensionManagerError(
                `Could not install extension ${prepared.loaded.manifest.id}: ${errorMessage(error)}`,
            );
        }
        const preview = installPreview(
            directory,
            sourcePath,
            {
                loaded: loadExtensionManifest(destination),
                digest: record!.digest,
            },
            false,
        );
        return { preview, record };
    });
}

export function setExtensionEnabled(
    id: string,
    enabled: boolean,
    options: ExtensionManagerOptions = {},
): ManagedExtensionRecord {
    const directory = extensionDirectoryFor(options);
    const registryPath = extensionRegistryPathFor(options);
    return withRegistryLock(registryPath, () => {
        assertSafeExtensionDirectory(directory);
        const records = readManagedExtensionRecords(directory, registryPath);
        const record = records.find((entry) => entry.id === id);
        if (record === undefined) {
            throw new ExtensionManagerError(
                `No managed extension named ${id} is installed`,
            );
        }
        const path = extensionPath(directory, record);
        assertManagedPathSafe(path);
        if (!isManagedDirectoryPresent(path)) {
            removeManagedRecord(directory, registryPath, records, id);
            throw new ExtensionManagerError(
                `Managed extension ${id} is missing from ${path}; the stale record was cleared`,
            );
        }
        const updated = { ...record, enabled };
        if (!enabled) writeManagedMarker(directory, updated);
        writeExtensionRegistry(directory, registryPath, {
            schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
            extensions: records.map((entry) => entry.id === id ? updated : entry),
        });
        if (enabled) writeManagedMarker(directory, updated);
        return updated;
    });
}

// Included extensions switch in config.json, installed ones in extensions.json.
export function setAnyExtensionEnabled(
    id: string,
    enabled: boolean,
    options: ExtensionManagerOptions = {},
): { readonly id: string } {
    const home = veraProfileDirectory(process.env, options.home);
    if (installedExtensionIdsIn(home).includes(id) || !includedExtensionIds().includes(id)) {
        return setExtensionEnabled(id, enabled, options);
    }
    return setIncludedExtensionEnabled(id, enabled, { path: join(home, "config.json") });
}

// Writes `disabled_included_extensions` in config.json.
export function setIncludedExtensionEnabled(
    id: string,
    enabled: boolean,
    options: LoadVeraConfigOptions = {},
): { readonly id: string } {
    if (!includedExtensionIds().includes(id)) {
        throw new ExtensionManagerError(
            `No extension named ${id} is included with Vera`,
        );
    }
    updateVeraConfigDefaults({ included_extension: { id, enabled } }, options);
    return { id };
}

export function removeExtension(
    id: string,
    options: ExtensionManagerOptions = {},
): ManagedExtensionRecord {
    const directory = extensionDirectoryFor(options);
    const registryPath = extensionRegistryPathFor(options);
    return withRegistryLock(registryPath, () => {
        assertSafeExtensionDirectory(directory);
        const records = readManagedExtensionRecords(directory, registryPath);
        const record = records.find((entry) => entry.id === id);
        if (record === undefined) {
            throw new ExtensionManagerError(
                `No managed extension named ${id} is installed`,
            );
        }
        const path = extensionPath(directory, record);
        assertManagedPathSafe(path);
        if (!isManagedDirectoryPresent(path)) {
            removeManagedRecord(directory, registryPath, records, id);
            return record;
        }

        const tombstone = join(
            directory,
            `.removing-${id}-${process.pid}-${randomUUID()}`,
        );
        renameSync(path, tombstone);
        try {
            removeManagedRecord(directory, registryPath, records, id);
        } catch (error) {
            renameSync(tombstone, path);
            throw error;
        }
        rmSync(tombstone, { recursive: true, force: true });
        return record;
    });
}

export function listExtensions(
    options: ExtensionManagerOptions = {},
): readonly ExtensionListEntry[] {
    const directory = extensionDirectoryFor(options);
    const registryPath = extensionRegistryPathFor(options);
    assertSafeExtensionDirectory(directory);
    const records = readManagedExtensionRecords(directory, registryPath);
    const managedPaths = new Set<string>();
    const entries: ExtensionListEntry[] = [];
    for (const record of records) {
        const path = extensionPath(directory, record);
        managedPaths.add(path);
        try {
            const manifest = loadExtensionManifest(path).manifest;
            entries.push({
                id: record.id,
                version: manifest.version,
                enabled: record.enabled,
                managed: true,
                path,
                source: record.source.path,
                digest: record.digest,
                capabilities: manifest.capabilities,
            });
        } catch (error) {
            entries.push({
                id: record.id,
                version: record.version,
                enabled: record.enabled,
                managed: true,
                path,
                source: record.source.path,
                digest: record.digest,
                error: errorMessage(error),
            });
        }
    }

    let children: readonly string[] = [];
    try {
        children = readdirSync(directory).toSorted();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            entries.push({
                id: "<directory>",
                enabled: false,
                managed: false,
                path: directory,
                error: errorMessage(error),
            });
        }
    }
    for (const child of children) {
        if (child.startsWith(".")) continue;
        const path = join(directory, child);
        if (managedPaths.has(path) || !isDirectory(path)) continue;
        try {
            const manifest = loadExtensionManifest(path).manifest;
            entries.push({
                id: manifest.id,
                version: manifest.version,
                enabled: true,
                managed: false,
                path,
                capabilities: manifest.capabilities,
            });
        } catch {
        }
    }
    return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

export function digestExtensionDirectory(directory: string): string {
    const hash = createHash("sha256");
    hashDirectory(hash, directory, "");
    return `sha256:${hash.digest("hex")}`;
}

function writeExtensionRegistry(
    directory: string,
    path: string,
    registry: ExtensionRegistryDocument,
): void {
    assertSafeExtensionDirectory(directory);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parsed = parseRegistry(registry);
    if (parsed === undefined) {
        throw new ExtensionManagerError("Refusing to write an invalid extension registry");
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        const ordered = [...parsed.extensions].toSorted((left, right) =>
            left.id.localeCompare(right.id)
        );
        writeFileSync(
            temporary,
            `${JSON.stringify({
                schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
                extensions: ordered,
            }, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        renameSync(temporary, path);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
}

function removeManagedMarker(directory: string, id: string): void {
    const path = join(directory, MANAGED_STATE_DIRECTORY, `${id}.json`);
    try {
        if (lstatSync(path).isSymbolicLink()) {
            throw new ExtensionManagerError(`Managed extension state is a symlink: ${path}`);
        }
        rmSync(path, { force: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function removeManagedRecord(
    directory: string,
    registryPath: string,
    records: readonly ManagedExtensionRecord[],
    id: string,
): void {
    const remaining = records.filter((record) => record.id !== id);
    if (fileExists(registryPath) || remaining.length > 0) {
        writeExtensionRegistry(directory, registryPath, {
            schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
            extensions: remaining,
        });
    }
    removeManagedMarker(directory, id);
}

function repairMissingRecords(
    directory: string,
    _registryPath: string,
    records: readonly ManagedExtensionRecord[],
): readonly ManagedExtensionRecord[] {
    const active: ManagedExtensionRecord[] = [];
    for (const record of records) {
        const path = extensionPath(directory, record);
        assertManagedPathSafe(path);
        if (isManagedDirectoryPresent(path)) {
            active.push(record);
        } else {
            removeManagedMarker(directory, record.id);
        }
    }
    return active;
}

function assertInstallSlot(
    directory: string,
    id: string,
    records: readonly ManagedExtensionRecord[],
): void {
    const existing = records.find((record) => record.id === id);
    if (existing !== undefined) {
        throw new ExtensionManagerError(
            `Extension ${id} is already installed. To replace it, run /extension remove ${id}, then install again.`,
        );
    }
    const destination = join(directory, id);
    try {
        if (lstatSync(destination).isSymbolicLink()) {
            throw new ExtensionManagerError(
                `Extension destination is a symlink: ${destination}`,
            );
        }
        throw new ExtensionManagerError(
            `Extension destination already exists: ${destination}`,
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function stableSource(sourcePath: string): PreparedSource {
    const first = prepareSource(sourcePath);
    const second = prepareSource(sourcePath);
    if (first.digest !== second.digest) {
        throw new ExtensionManagerError(
            `Extension source changed while it was being inspected: ${sourcePath}`,
        );
    }
    return second;
}

function prepareSource(sourcePath: string): PreparedSource {
    try {
        if (lstatSync(sourcePath).isSymbolicLink()) {
            throw new ExtensionManagerError(
                `Extension source directory is a symlink: ${sourcePath}`,
            );
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const loaded = loadExtensionManifest(sourcePath);
    return { loaded, digest: digestExtensionDirectory(loaded.directory) };
}

interface PreparedSource {
    readonly loaded: ReturnType<typeof loadExtensionManifest>;
    readonly digest: string;
}

function installPreview(
    directory: string,
    sourcePath: string,
    prepared: PreparedSource,
    dryRun: boolean,
): ExtensionInstallPreview {
    return {
        id: prepared.loaded.manifest.id,
        version: prepared.loaded.manifest.version,
        source: sourcePath,
        destination: join(directory, prepared.loaded.manifest.id),
        digest: prepared.digest,
        capabilities: prepared.loaded.manifest.capabilities,
        unreviewedTools: prepared.loaded.manifest.unreviewedTools,
        dryRun,
    };
}

function isDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

function withRegistryLock<T>(registryPath: string, action: () => T): T {
    const lockPath = `${registryPath}.lock`;
    mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
    let descriptor: number;
    while (true) {
        try {
            descriptor = openSync(lockPath, "wx", 0o600);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (!reclaimDeadLock(lockPath)) {
                throw new ExtensionManagerError(
                    `Another extension operation is using ${dirname(registryPath)}`,
                );
            }
        }
    }
    try {
        const owner = Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`);
        writeSync(descriptor, owner, 0, owner.byteLength, 0);
        return action();
    } finally {
        closeSync(descriptor);
        rmSync(lockPath, { force: true });
    }
}

function reclaimDeadLock(path: string): boolean {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return false;
    }
    if (!isRecord(value) || typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
        return false;
    }
    try {
        process.kill(value.pid, 0);
        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    rmSync(path, { force: true });
    return true;
}

function hashDirectory(
    hash: ReturnType<typeof createHash>,
    directory: string,
    relativeDirectory: string,
): void {
    const entries = readdirSync(directory, { withFileTypes: true })
        .toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        const relativePath = relativeDirectory === ""
            ? entry.name
            : join(relativeDirectory, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            hash.update(`dir:${relativePath}\n`);
            hashDirectory(hash, path, relativePath);
        } else if (entry.isFile()) {
            hash.update(`file:${relativePath}\n`);
            hash.update(readFileSync(path));
            hash.update("\n");
        } else if (entry.isSymbolicLink()) {
            throw new ExtensionManagerError(
                `Symlinks are not supported in extension sources: ${path}`,
            );
        } else {
            throw new ExtensionManagerError(
                `Unsupported file in extension source: ${path}`,
            );
        }
    }
}
