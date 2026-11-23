import {
    EXTENSION_REGISTRY_SCHEMA_VERSION, MANAGED_STATE_DIRECTORY, ExtensionManagerError,
    assertSafeExtensionDirectory,
    parseRegistry, readManagedExtensionRecords, writeManagedMarker,
    assertManagedPathSafe, isManagedDirectoryPresent,
    extensionPath, fileExists, errorMessage,
    type ManagedExtensionRecord, type ExtensionRegistryDocument,
} from "./managed-registry.ts";
export {
    EXTENSION_REGISTRY_SCHEMA_VERSION, ExtensionManagerError, assertSafeExtensionDirectory,
    readExtensionRegistry, managedExtensionConfigs,
} from "./managed-registry.ts";
export type { ManagedExtensionSource, ManagedExtensionRecord, ExtensionRegistryDocument } from "./managed-registry.ts";
import { randomUUID } from "node:crypto";
import {
    lstatSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
    inspectDirectory,
    unlimitedDirectoryLimits,
    withFileLock,
} from "../store/managed-directory.ts";

import {
    loadOptionalVeraConfig,
    updateVeraConfigDefaults,
    type LoadVeraConfigOptions,
} from "../config.ts";
import { includedExtensionIds, includedExtensions } from "./included.ts";
import { installPlugin, listPlugins, removePluginForExtension, type PluginInstallPreview } from "../plugins/manager.ts";
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
    readonly plugin?: PluginInstallPreview;
}

export interface ExtensionInstallResult {
    readonly preview: ExtensionInstallPreview;
    readonly record?: { readonly id: string };
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
    const result = installPlugin(source, { home: options.home, dry_run: options.dryRun });
    const preview = result.preview;
    return {
        preview: {
            id: preview.name,
            version: preview.version ?? "?",
            source: preview.source_path,
            destination: preview.directory,
            digest: preview.digest,
            capabilities: preview.components.host_extension?.capabilities ?? [],
            unreviewedTools: [],
            dryRun: preview.dry_run,
            plugin: preview,
        },
        ...(result.record === null ? {} : { record: { id: result.record.name } }),
    };
}

export function setExtensionEnabled(
    id: string,
    enabled: boolean,
    options: ExtensionManagerOptions = {},
): ManagedExtensionRecord {
    rejectPluginToggle(id, enabled, options);
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
    rejectPluginToggle(id, enabled, options);
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
): ManagedExtensionRecord | { readonly id: string; readonly plugin: string; readonly data_directory: string; readonly legacy_removed?: readonly string[] } {
    const removal = removePluginForExtension(id, options);
    if (removal !== undefined) {
        return { id, plugin: removal.record.name, data_directory: removal.data_directory,
            ...(removal.legacy_removed === undefined ? {} : { legacy_removed: removal.legacy_removed }) };
    }
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


export function listIncludedExtensions(options: ExtensionManagerOptions = {}): readonly ExtensionListEntry[] {
    const home = veraProfileDirectory(process.env, options.home);
    const config = loadOptionalVeraConfig({ path: join(home, "config.json") });
    const disabled = new Set(config?.disabled_included_extensions ?? []);
    return includedExtensions().map((extension) => {
        try {
            const manifest = loadExtensionManifest(extension.path).manifest;
            return {
                id: manifest.id, version: manifest.version, enabled: !disabled.has(manifest.id),
                included: true, core: extension.core, managed: false, path: extension.path,
                source: extension.core ? "Core" : "Included", capabilities: manifest.capabilities,
            };
        } catch (error) {
            return {
                id: extension.id ?? extension.path, enabled: false, included: true,
                core: extension.core, managed: false, path: extension.path,
                source: extension.core ? "Core" : "Included", error: errorMessage(error),
            };
        }
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
    return inspectDirectory(
        directory,
        unlimitedDirectoryLimits(),
        extensionError,
    ).digest;
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

function pluginOwner(id: string, options: ExtensionManagerOptions) {
    return listPlugins(options).plugins.map((entry) => entry.record).find((record) =>
        record.components.host_extension === id || record.components.desktop_extension === id
    );
}

function rejectPluginToggle(id: string, enabled: boolean, options: ExtensionManagerOptions): void {
    const owner = pluginOwner(id, options);
    if (owner !== undefined) {
        const operation = enabled ? "enable" : "disable";
        throw new ExtensionManagerError(`Extension ${id} belongs to plugin ${owner.name}. Run vera plugin ${operation} ${owner.name}.`);
    }
}

function isDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

function withRegistryLock<T>(registryPath: string, action: () => T): T {
    return withFileLock(
        `${registryPath}.lock`,
        action,
        extensionError,
        `Another extension operation is using ${dirname(registryPath)}`,
    );
}

function extensionError(message: string): Error {
    return new ExtensionManagerError(message);
}
