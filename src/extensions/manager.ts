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
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { VeraExtensionConfig } from "../config.ts";
import { loadExtensionManifest } from "./manifest.ts";
import { veraProfileDirectory } from "../profile-paths.ts";

export const EXTENSION_REGISTRY_SCHEMA_VERSION = 1;
const MANAGED_STATE_DIRECTORY = ".managed";
const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export type ExtensionManagerScope = "profile" | "project";

export interface ExtensionManagerTarget {
    readonly scope: ExtensionManagerScope;
    readonly projectRoot?: string;
}

export interface ManagedExtensionSource {
    readonly kind: "local";
    readonly path: string;
}

export interface ManagedExtensionRecord {
    readonly id: string;
    readonly version: string;
    readonly source: ManagedExtensionSource;
    readonly digest: string;
    /** Relative to the scope root, normally `extensions/<id>`. */
    readonly directory: string;
    readonly enabled: boolean;
    readonly installedAt: string;
}

export interface ExtensionRegistryDocument {
    readonly schema_version: typeof EXTENSION_REGISTRY_SCHEMA_VERSION;
    readonly extensions: readonly ManagedExtensionRecord[];
}

export interface ExtensionInstallPreview {
    readonly scope: ExtensionManagerScope;
    readonly projectRoot?: string;
    readonly id: string;
    readonly version: string;
    readonly source: string;
    readonly destination: string;
    readonly digest: string;
    readonly capabilities: readonly string[];
    readonly dryRun: boolean;
}

export interface ExtensionInstallResult {
    readonly preview: ExtensionInstallPreview;
    readonly record?: ManagedExtensionRecord;
}

export interface ExtensionListEntry {
    readonly scope: ExtensionManagerScope;
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

export interface ExtensionListOptions extends ExtensionManagerOptions {
    readonly projectRoot?: string;
    readonly scope?: ExtensionManagerScope;
}

export interface ExtensionManagerOperations {
    readonly install: typeof installExtension;
    readonly list: typeof listExtensions;
    readonly setEnabled: typeof setExtensionEnabled;
    readonly remove: typeof removeExtension;
}

export class ExtensionManagerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExtensionManagerError";
    }
}

export function projectExtensionDirectory(projectRoot: string): string {
    return join(canonicalProjectRoot(projectRoot), ".vera", "extensions");
}

export function extensionDirectoryFor(
    target: ExtensionManagerTarget,
    options: ExtensionManagerOptions = {},
): string {
    return target.scope === "profile"
        ? join(veraProfileDirectory(process.env, options.home), "extensions")
        : projectExtensionDirectory(requireProjectRoot(target));
}

export function extensionRegistryPathFor(
    target: ExtensionManagerTarget,
    options: ExtensionManagerOptions = {},
): string {
    return join(dirname(extensionDirectoryFor(target, options)), "extensions.json");
}

/** Reject scope boundaries that would make a manager write through a symlink. */
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

/**
 * Marker state is hidden from ordinary discovery and lets a missing central
 * registry fail closed instead of re-enabling a disabled managed directory.
 */
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

export function installExtension(
    source: string,
    target: ExtensionManagerTarget,
    options: ExtensionManagerOptions & { readonly dryRun?: boolean } = {},
): ExtensionInstallResult {
    const directory = extensionDirectoryFor(target, options);
    const registryPath = extensionRegistryPathFor(target, options);
    assertSafeExtensionDirectory(directory);
    const sourcePath = resolve(source);

    if (options.dryRun === true) {
        const prepared = stableSource(sourcePath);
        const records = readManagedExtensionRecords(directory, registryPath);
        assertInstallSlot(directory, target, prepared.loaded.manifest.id, records);
        return {
            preview: installPreview(target, directory, sourcePath, prepared, true),
        };
    }

    return withRegistryLock(registryPath, () => {
        assertSafeExtensionDirectory(directory);
        const prepared = stableSource(sourcePath);
        const records = readManagedExtensionRecords(directory, registryPath);
        const activeRecords = repairMissingRecords(directory, registryPath, records);
        assertInstallSlot(
            directory,
            target,
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
            // The marker exists before the final rename. A crash at any point
            // therefore leaves either an inert missing-path record or a fully
            // recoverable installed extension.
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
                    // A missing-path record is inert and fails closed.
                }
            }
            if (markerWritten) {
                try {
                    removeManagedMarker(directory, record!.id);
                } catch {
                    // A marker for a missing final path cannot activate code.
                }
            }
            rmSync(staging, { recursive: true, force: true });
            if (error instanceof ExtensionManagerError) throw error;
            throw new ExtensionManagerError(
                `Could not install extension ${prepared.loaded.manifest.id}: ${errorMessage(error)}`,
            );
        }
        const preview = installPreview(
            target,
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
    target: ExtensionManagerTarget,
    options: ExtensionManagerOptions = {},
): ManagedExtensionRecord {
    const directory = extensionDirectoryFor(target, options);
    const registryPath = extensionRegistryPathFor(target, options);
    return withRegistryLock(registryPath, () => {
        assertSafeExtensionDirectory(directory);
        const records = readManagedExtensionRecords(directory, registryPath);
        const record = records.find((entry) => entry.id === id);
        if (record === undefined) {
            throw new ExtensionManagerError(
                `No managed extension named ${id} exists in the ${target.scope} scope`,
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
        // Disable first: a crash before the central registry swap remains
        // disabled. Enable central state first: an old marker can only keep it
        // disabled until the marker update completes.
        if (!enabled) writeManagedMarker(directory, updated);
        writeExtensionRegistry(directory, registryPath, {
            schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
            extensions: records.map((entry) => entry.id === id ? updated : entry),
        });
        if (enabled) writeManagedMarker(directory, updated);
        return updated;
    });
}

export function removeExtension(
    id: string,
    target: ExtensionManagerTarget,
    options: ExtensionManagerOptions = {},
): ManagedExtensionRecord {
    const directory = extensionDirectoryFor(target, options);
    const registryPath = extensionRegistryPathFor(target, options);
    return withRegistryLock(registryPath, () => {
        assertSafeExtensionDirectory(directory);
        const records = readManagedExtensionRecords(directory, registryPath);
        const record = records.find((entry) => entry.id === id);
        if (record === undefined) {
            throw new ExtensionManagerError(
                `No managed extension named ${id} exists in the ${target.scope} scope`,
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
    options: ExtensionListOptions = {},
): readonly ExtensionListEntry[] {
    const targets: ExtensionManagerTarget[] = [];
    if (options.scope === undefined || options.scope === "profile") {
        targets.push({ scope: "profile" });
    }
    if (
        options.projectRoot !== undefined
        && (options.scope === undefined || options.scope === "project")
    ) {
        targets.push({ scope: "project", projectRoot: options.projectRoot });
    }
    return targets.flatMap((target) => listScopeExtensions(target, options));
}

export function digestExtensionDirectory(directory: string): string {
    const hash = createHash("sha256");
    hashDirectory(hash, directory, "");
    return `sha256:${hash.digest("hex")}`;
}

function listScopeExtensions(
    target: ExtensionManagerTarget,
    options: ExtensionManagerOptions,
): readonly ExtensionListEntry[] {
    const directory = extensionDirectoryFor(target, options);
    const registryPath = extensionRegistryPathFor(target, options);
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
                scope: target.scope,
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
                scope: target.scope,
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
                scope: target.scope,
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
                scope: target.scope,
                id: manifest.id,
                version: manifest.version,
                enabled: true,
                managed: false,
                path,
                capabilities: manifest.capabilities,
            });
        } catch {
            // A directory without a manifest is not an extension installation.
        }
    }
    return entries.toSorted((left, right) =>
        `${left.scope}:${left.id}`.localeCompare(`${right.scope}:${right.id}`)
    );
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

function parseRegistry(value: unknown): ExtensionRegistryDocument | undefined {
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

function readManagedExtensionRecords(
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
            // Backfill the crash-safe marker for registries written by the
            // first manager version. If the registry later disappears, a
            // disabled record must not become ordinary enabled discovery.
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

function writeManagedMarker(directory: string, record: ManagedExtensionRecord): void {
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
    target: ExtensionManagerTarget,
    id: string,
    records: readonly ManagedExtensionRecord[],
): void {
    const existing = records.find((record) => record.id === id);
    if (existing !== undefined) {
        throw new ExtensionManagerError(
            `Extension ${id} is already installed in the ${target.scope} scope`,
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

function assertManagedPathSafe(path: string): void {
    try {
        if (lstatSync(path).isSymbolicLink()) {
            throw new ExtensionManagerError(`Managed extension path is a symlink: ${path}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function isManagedDirectoryPresent(path: string): boolean {
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
    target: ExtensionManagerTarget,
    directory: string,
    sourcePath: string,
    prepared: PreparedSource,
    dryRun: boolean,
): ExtensionInstallPreview {
    return {
        scope: target.scope,
        ...(target.scope === "project"
            ? { projectRoot: requireProjectRoot(target) }
            : {}),
        id: prepared.loaded.manifest.id,
        version: prepared.loaded.manifest.version,
        source: sourcePath,
        destination: join(directory, prepared.loaded.manifest.id),
        digest: prepared.digest,
        capabilities: prepared.loaded.manifest.capabilities,
        dryRun,
    };
}

function managedExtensionDirectory(id: string): string {
    return join("extensions", id);
}

function extensionPath(
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

function requireProjectRoot(target: ExtensionManagerTarget): string {
    if (target.scope !== "project" || target.projectRoot === undefined) {
        throw new ExtensionManagerError(
            "Project-scoped extension operations require a project root",
        );
    }
    const root = resolve(target.projectRoot);
    try {
        if (lstatSync(root).isSymbolicLink()) {
            throw new ExtensionManagerError(
                `Project root is a symlink; use its real path: ${root}`,
            );
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return canonicalProjectRoot(root);
}

function canonicalProjectRoot(projectRoot: string): string {
    let current = resolve(projectRoot);
    const missing: string[] = [];
    while (true) {
        try {
            return join(realpathSync(current), ...missing.reverse());
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                return resolve(projectRoot);
            }
            const parent = dirname(current);
            if (parent === current) return resolve(projectRoot);
            missing.push(current.slice(parent.length + 1));
            current = parent;
        }
    }
}

function isDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

function fileExists(path: string): boolean {
    try {
        return lstatSync(path).isFile();
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
