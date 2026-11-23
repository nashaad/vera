import { randomUUID } from "node:crypto";
import {
    cpSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
    defaultVeraConfigPath,
    loadOptionalVeraConfig,
} from "../config.ts";
import { includedExtensions } from "../extensions/included.ts";
import { isIncludedExtensionOn } from "../extensions/included-state.ts";
import {
    directoryMatchesTotals,
    directorySize,
    inspectDirectory,
    withFileLock,
    type DirectoryLimits,
    type DirectorySnapshot,
} from "../store/managed-directory.ts";
import {
    pluginDataDirectoryIn,
    pluginDirectoryIn,
    pluginRegistryPathIn,
    pluginsDirectoryIn,
    veraProfileDirectory,
} from "../profile-paths.ts";
import {
    needsDesktopRestart,
    needsHostRestart,
    summarizePluginComponents,
    type PluginComponentSummary,
    type PluginComponents,
} from "./components.ts";
import { PluginManifestError } from "./errors.ts";
import { withMigratedLegacyRemoval } from "./migrate-remove.ts";
import { mapPluginMcpServers, type PluginMcpMapping } from "./mcp.ts";
import { loadPluginPackage, type LoadedPluginPackage, type PluginLayout } from "./manifest.ts";
import {
    assertSafePluginData,
    assertSafePluginStore,
    MAX_PLUGINS,
    PluginManagerError,
    readPluginRegistry,
    writePluginRegistry,
    type PluginRecord,
    type PluginRegistryDocument,
} from "./registry.ts";

export { MAX_PLUGINS };

export const PLUGIN_PACKAGE_LIMITS: DirectoryLimits = {
    max_entries: 2_000,
    max_file_bytes: 4 * 1024 * 1024,
    max_total_bytes: 32 * 1024 * 1024,
    max_path_characters: 512,
};

export interface PluginManagerOptions {
    readonly home?: string;
}

export interface InstallPluginOptions extends PluginManagerOptions {
    readonly dry_run?: boolean;
}

export interface PluginStorePaths {
    readonly vera_home: string;
    readonly plugins_directory: string;
    readonly registry_path: string;
}

export interface PluginInstallPreview {
    readonly name: string;
    readonly layout: PluginLayout;
    readonly version?: string;
    readonly description?: string;
    readonly source_path: string;
    readonly directory: string;
    readonly digest: string;
    readonly entries: number;
    readonly total_bytes: number;
    readonly enabled: boolean;
    readonly replaces: PluginReplacement | null;
    readonly dry_run: boolean;
    readonly components: PluginComponents;
    readonly mcp: PluginMcpMapping;
    readonly mcp_enabled: boolean;
    readonly ignored: readonly string[];
    readonly warnings: readonly string[];
}

export interface PluginReplacement {
    readonly name: string;
    readonly source_path: string;
}

export interface PluginInstallResult {
    readonly preview: PluginInstallPreview;
    readonly record: PluginRecord | null;
    readonly noop: boolean;
}

export interface PluginListEntry {
    readonly record: PluginRecord;
    readonly path: string;
    readonly modified: boolean;
    readonly problem: string | null;
}

export interface PluginListResult {
    readonly plugins: readonly PluginListEntry[];
    readonly orphans: readonly string[];
}

export interface PluginShowResult {
    readonly record: PluginRecord;
    readonly path: string;
    readonly digest: string;
    readonly modified: boolean;
    readonly package: LoadedPluginPackage;
    readonly mcp: PluginMcpMapping;
    readonly mcp_enabled: boolean;
    readonly data_directory: string;
    readonly data_bytes: number;
}

export interface PluginRemoval {
    readonly record: PluginRecord;
    readonly data_directory: string;
    readonly data_kept: boolean;
    readonly data_bytes: number;
    readonly legacy_removed?: readonly string[];
}

export interface PluginManagerOperations {
    install(options: InstallPluginOptions & { source: string }): PluginInstallResult;
    list(options?: PluginManagerOptions): PluginListResult;
    show(name: string, options?: PluginManagerOptions): PluginShowResult;
    setEnabled(
        name: string,
        enabled: boolean,
        options?: PluginManagerOptions,
    ): PluginRecord;
    remove(
        name: string,
        options: PluginManagerOptions & { purge?: boolean },
    ): PluginRemoval;
}

export const pluginManager: PluginManagerOperations = {
    install: (options) => installPlugin(options.source, options),
    list: listPlugins,
    show: showPlugin,
    setEnabled: setPluginEnabled,
    remove: removePlugin,
};

export function pluginStorePaths(options: PluginManagerOptions = {}): PluginStorePaths {
    const veraHome = veraProfileDirectory(process.env, options.home);
    return {
        vera_home: veraHome,
        plugins_directory: pluginsDirectoryIn(veraHome),
        registry_path: pluginRegistryPathIn(veraHome),
    };
}

export function installPlugin(
    source: string,
    options: InstallPluginOptions = {},
): PluginInstallResult {
    const paths = pluginStorePaths(options);
    assertSafePluginStore(paths.plugins_directory, paths.registry_path);
    const dryRun = options.dry_run === true;
    const mcpEnabled = mcpServersEnabled(paths.vera_home);

    if (dryRun) {
        const prepared = preparePackage(source);
        const registry = readPluginRegistry(paths.registry_path);
        const choice = chooseInstallName(prepared.package, registry);
        assertHostExtensionIdAvailable(prepared.package, choice.name, registry);
        assertDesktopExtensionIdAvailable(prepared.package, choice.name, registry);
        const noop = isNoopInstall(paths, choice.existing, prepared.snapshot.digest);
        return {
            preview: previewFor(
                prepared,
                paths,
                choice.name,
                choice.existing,
                noop,
                dryRun,
                mcpEnabled,
            ),
            record: null,
            noop,
        };
    }

    return withFileLock(`${paths.registry_path}.lock`, () => {
        assertSafePluginStore(paths.plugins_directory, paths.registry_path);
        const prepared = preparePackage(source);
        const registry = readPluginRegistry(paths.registry_path);
        const choice = chooseInstallName(prepared.package, registry);
        assertHostExtensionIdAvailable(prepared.package, choice.name, registry);
        assertDesktopExtensionIdAvailable(prepared.package, choice.name, registry);
        const noop = isNoopInstall(paths, choice.existing, prepared.snapshot.digest);
        const preview = previewFor(
            prepared,
            paths,
            choice.name,
            choice.existing,
            noop,
            false,
            mcpEnabled,
        );
        if (noop) {
            return { preview, record: choice.existing ?? null, noop: true };
        }
        if (choice.existing === undefined && registry.plugins.length >= MAX_PLUGINS) {
            throw new PluginManagerError(
                `Vera keeps at most ${MAX_PLUGINS} plugins. Remove one first.`,
            );
        }

        mkdirSync(paths.plugins_directory, { recursive: true, mode: 0o700 });
        const staging = join(
            paths.plugins_directory,
            `.staging-${choice.name}-${process.pid}-${randomUUID()}`,
        );
        try {
            cpSync(prepared.package.directory, staging, {
                recursive: true,
                errorOnExist: true,
                force: false,
            });
            const copied = inspectDirectory(
                staging,
                PLUGIN_PACKAGE_LIMITS,
                pluginError,
            );
            if (copied.digest !== prepared.snapshot.digest) {
                throw new PluginManagerError(
                    `Plugin changed while it was being copied: ${prepared.package.directory}`,
                );
            }
            const record = buildRecord(
                prepared.package,
                choice.name,
                prepared.package.directory,
                copied,
                choice.existing?.enabled ?? true,
            );
            const document: PluginRegistryDocument = {
                schema_version: 1,
                plugins: [
                    ...registry.plugins.filter((entry) => entry.name !== choice.name),
                    record,
                ],
            };
            installDirectory(
                paths.plugins_directory,
                choice.name,
                staging,
                document,
                paths.registry_path,
            );
            return { preview, record, noop: false };
        } finally {
            rmSync(staging, { recursive: true, force: true });
        }
    }, pluginError);
}

export function listPlugins(options: PluginManagerOptions = {}): PluginListResult {
    const paths = pluginStorePaths(options);
    assertSafePluginStore(paths.plugins_directory, paths.registry_path);
    const registry = readPluginRegistry(paths.registry_path);
    const plugins = registry.plugins.map((record) => {
        const path = pluginDirectoryIn(paths.vera_home, record.name);
        if (!directoryExists(path)) {
            return {
                record,
                path,
                modified: false,
                problem: "the installed folder is missing",
            };
        }
        let problem: string | null = null;
        let modified = false;
        try {
            modified = !directoryMatchesTotals(path, record);
        } catch (error) {
            problem = errorMessage(error);
            modified = true;
        }
        return { record, path, modified, problem };
    });
    const orphans: string[] = [];
    let entries: string[] = [];
    try {
        entries = readdirSync(paths.plugins_directory);
    } catch {
        entries = [];
    }
    const recorded = new Set(registry.plugins.map((record) => record.name));
    for (const entry of entries.toSorted()) {
        if (entry.startsWith(".")) continue;
        if (recorded.has(entry)) continue;
        orphans.push(join(paths.plugins_directory, entry));
    }
    return { plugins, orphans };
}

export function showPlugin(
    name: string,
    options: PluginManagerOptions = {},
): PluginShowResult {
    const paths = pluginStorePaths(options);
    assertSafePluginStore(paths.plugins_directory, paths.registry_path);
    const registry = readPluginRegistry(paths.registry_path);
    const record = findRecord(registry, name);
    const path = pluginDirectoryIn(paths.vera_home, name);
    if (!directoryExists(path)) {
        throw new PluginManagerError(
            `Plugin ${name} is recorded but its folder is missing: ${path}`,
        );
    }
    const snapshot = inspectDirectory(path, PLUGIN_PACKAGE_LIMITS, pluginError);
    assertSafePluginData(paths.plugins_directory, name);
    let loaded: LoadedPluginPackage;
    try {
        loaded = loadPluginPackage(path);
    } catch (error) {
        throw new PluginManagerError(
            `Plugin ${name} could not be read: ${errorMessage(error)}`,
        );
    }
    const dataDirectory = pluginDataDirectoryIn(paths.vera_home, name);
    return {
        record,
        path,
        digest: snapshot.digest,
        modified: snapshot.digest !== record.digest
            || !directoryMatchesTotals(path, record),
        package: loaded,
        mcp: mapPluginMcpServers({
            plugin: name,
            directory: path,
            dataDirectory,
            entries: loaded.components.mcp_servers,
        }),
        mcp_enabled: mcpServersEnabled(paths.vera_home),
        data_directory: dataDirectory,
        data_bytes: directorySize(dataDirectory),
    };
}

export function setPluginEnabled(
    name: string,
    enabled: boolean,
    options: PluginManagerOptions = {},
): PluginRecord {
    const paths = pluginStorePaths(options);
    assertSafePluginStore(paths.plugins_directory, paths.registry_path);
    return withFileLock(`${paths.registry_path}.lock`, () => {
        const registry = readPluginRegistry(paths.registry_path);
        const record = findRecord(registry, name);
        const updated: PluginRecord = { ...record, enabled };
        writePluginRegistry(paths.registry_path, {
            schema_version: 1,
            plugins: registry.plugins.map((entry) =>
                entry.name === name ? updated : entry
            ),
        });
        return updated;
    }, pluginError);
}

export function removePlugin(
    name: string,
    options: PluginManagerOptions & { readonly purge?: boolean } = {},
): PluginRemoval {
    const paths = pluginStorePaths(options);
    assertSafePluginStore(paths.plugins_directory, paths.registry_path);
    return withFileLock(`${paths.registry_path}.lock`, () => {
        const registry = readPluginRegistry(paths.registry_path);
        const record = findRecord(registry, name);
        const dataDirectory = pluginDataDirectoryIn(paths.vera_home, name);
        assertSafePluginData(paths.plugins_directory, name);
        const dataBytes = directorySize(dataDirectory);
        const destination = pluginDirectoryIn(paths.vera_home, name);
        const tombstone = join(
            paths.plugins_directory,
            `.removed-${name}-${process.pid}-${randomUUID()}`,
        );
        const legacyRemoved = withMigratedLegacyRemoval(paths.vera_home, record, (removedPaths) => {
            let moved = false;
            if (directoryExists(destination)) {
                assertNotSymlink(destination, "Plugin folder");
                renameSync(destination, tombstone);
                moved = true;
            }
            try {
                writePluginRegistry(paths.registry_path, {
                    schema_version: 1,
                    plugins: registry.plugins.filter((entry) => entry.name !== name),
                });
            } catch (error) {
                if (moved) renameSync(tombstone, destination);
                throw error;
            }
            return removedPaths;
        });
        rmSync(tombstone, { recursive: true, force: true });

        if (options.purge === true) {
            rmSync(dataDirectory, { recursive: true, force: true });
        }
        return {
            record,
            data_directory: dataDirectory,
            data_kept: options.purge !== true,
            data_bytes: dataBytes,
            ...(legacyRemoved.length === 0 ? {} : { legacy_removed: legacyRemoved }),
        };
    }, pluginError);
}


export function removePluginForExtension(
    id: string,
    options: PluginManagerOptions = {},
): PluginRemoval | undefined {
    const paths = pluginStorePaths(options);
    assertSafePluginStore(paths.plugins_directory, paths.registry_path);
    return withFileLock(`${paths.registry_path}.lock`, () => {
        const registry = readPluginRegistry(paths.registry_path);
        const owners = registry.plugins.filter((record) =>
            record.components.host_extension === id || record.components.desktop_extension === id
        );
        if (owners.length === 0) return undefined;
        const record = owners[0]!;
        const refusal = () => new PluginManagerError(
            `Extension ${id} belongs to plugin ${record.name}. Run vera plugin remove ${record.name}.`,
        );
        if (owners.length !== 1
            || (record.components.host_extension !== null && record.components.host_extension !== id)
            || (record.components.desktop_extension !== null && record.components.desktop_extension !== id)) {
            throw refusal();
        }
        const destination = pluginDirectoryIn(paths.vera_home, record.name);
        let pkg: LoadedPluginPackage;
        try {
            assertNotSymlink(destination, "Plugin folder");
            pkg = loadPluginPackage(destination);
        } catch {
            throw refusal();
        }
        const components = pkg.components;
        if ((components.host_extension?.id ?? null) !== record.components.host_extension
            || (components.desktop_extension?.id ?? null) !== record.components.desktop_extension
            || pkg.warnings.length > 0 || components.mcp_servers.length > 0) throw refusal();
        const roots = [components.host_extension?.directory, components.desktop_extension?.directory]
            .filter((root): root is string => root !== undefined);
        const inside = (path: string): boolean => roots.some((root) => {
            const part = relative(root, path);
            return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep));
        });
        if (components.skills.some((skill) => !inside(skill.directory)
                || (pkg.layout !== "extension" && skill.root === join(pkg.directory, "skills")))
            || components.agents.some((agent) => !inside(agent.path)
                || agent.root === join(pkg.directory, "agents"))) throw refusal();
        const dataDirectory = pluginDataDirectoryIn(paths.vera_home, record.name);
        assertSafePluginData(paths.plugins_directory, record.name);
        const dataBytes = directorySize(dataDirectory);
        const tombstone = join(paths.plugins_directory, `.removed-${record.name}-${process.pid}-${randomUUID()}`);
        const legacyRemoved = withMigratedLegacyRemoval(paths.vera_home, record, (removedPaths) => {
            renameSync(destination, tombstone);
            try {
                writePluginRegistry(paths.registry_path, {
                    schema_version: 1,
                    plugins: registry.plugins.filter((entry) => entry.name !== record.name),
                });
            } catch (error) {
                renameSync(tombstone, destination);
                throw error;
            }
            return removedPaths;
        });
        rmSync(tombstone, { recursive: true, force: true });
        return { record, data_directory: dataDirectory, data_kept: true, data_bytes: dataBytes,
            ...(legacyRemoved.length === 0 ? {} : { legacy_removed: legacyRemoved }) };
    }, pluginError);
}

export function pluginRestartNotes(
    summary: PluginComponentSummary,
    action: "enable" | "disable" = "enable",
): readonly string[] {
    const notes: string[] = [
        action === "enable"
            ? "A running session picks up the plugin's skills on its next turn."
            : "A running session stops seeing the plugin's skills on its next turn.",
    ];
    if (summary.agents.length > 0) {
        notes.push(
            action === "enable"
                ? "Its agents appear the next time agents are listed."
                : "Its agents drop out the next time agents are listed.",
        );
    }
    if (needsHostRestart(summary)) {
        notes.push(
            action === "enable"
                ? "Restart the resident host to apply extension code and MCP servers."
                : "Restart the resident host to stop extension code and MCP servers.",
        );
    }
    if (needsDesktopRestart(summary)) {
        notes.push("Restart the desktop app to load its desktop extension.");
    }
    return notes;
}

interface PreparedPackage {
    readonly package: LoadedPluginPackage;
    readonly snapshot: DirectorySnapshot;
}

function preparePackage(configuredSource: string): PreparedPackage {
    const sourcePath = resolve(configuredSource);
    let sourceDetails;
    try {
        sourceDetails = lstatSync(sourcePath);
    } catch (error) {
        throw new PluginManagerError(
            `Plugin source is unavailable at ${sourcePath}: ${errorMessage(error)}`,
        );
    }
    if (sourceDetails.isSymbolicLink()) {
        throw new PluginManagerError(
            `Plugin source is a symlink: ${sourcePath}`,
        );
    }
    if (!sourceDetails.isDirectory()) {
        throw new PluginManagerError(
            `Plugin source is not a directory: ${sourcePath}`,
        );
    }
    const first = inspectDirectory(sourcePath, PLUGIN_PACKAGE_LIMITS, pluginError);
    let loaded: LoadedPluginPackage;
    try {
        loaded = loadPluginPackage(sourcePath);
    } catch (error) {
        if (error instanceof PluginManifestError) {
            throw new PluginManagerError(error.message);
        }
        throw error;
    }
    const second = inspectDirectory(sourcePath, PLUGIN_PACKAGE_LIMITS, pluginError);
    if (first.digest !== second.digest) {
        throw new PluginManagerError(
            `Plugin changed while it was being read: ${sourcePath}`,
        );
    }
    return { package: loaded, snapshot: second };
}

function chooseInstallName(
    pkg: LoadedPluginPackage,
    registry: PluginRegistryDocument,
): { readonly name: string; readonly existing?: PluginRecord } {
    const existing = registry.plugins.find((entry) => entry.name === pkg.install_name);
    return existing === undefined
        ? { name: pkg.install_name }
        : { name: existing.name, existing };
}

function assertHostExtensionIdAvailable(
    pkg: LoadedPluginPackage,
    name: string,
    registry: PluginRegistryDocument,
): void {
    const id = pkg.components.host_extension?.id;
    if (id === undefined) return;

    const included = includedExtensions().find((extension) => extension.id === id);
    if (included !== undefined) {
        const kind = included.core ? "a core" : "an included";
        throw new PluginManagerError(
            `Host extension id ${id} is already used by ${kind} extension.`,
        );
    }
    const owner = registry.plugins.find((record) =>
        record.name !== name && record.components.host_extension === id
    );
    if (owner !== undefined) {
        throw new PluginManagerError(
            `Host extension id ${id} is already used by plugin ${owner.name}.`,
        );
    }
}

function assertDesktopExtensionIdAvailable(
    pkg: LoadedPluginPackage,
    name: string,
    registry: PluginRegistryDocument,
): void {
    const id = pkg.components.desktop_extension?.id;
    if (id === undefined) return;
    const owner = registry.plugins.find((record) =>
        record.name !== name && record.components.desktop_extension === id
    );
    if (owner !== undefined) {
        throw new PluginManagerError(
            `Desktop extension id ${id} is already used by plugin ${owner.name}.`,
        );
    }
}

function isNoopInstall(
    paths: PluginStorePaths,
    existing: PluginRecord | undefined,
    digest: string,
): boolean {
    if (existing === undefined || existing.digest !== digest) return false;
    const path = pluginDirectoryIn(paths.vera_home, existing.name);
    if (!directoryExists(path)) return false;
    try {
        return directoryMatchesTotals(path, existing);
    } catch {
        return false;
    }
}

function previewFor(
    prepared: PreparedPackage,
    paths: PluginStorePaths,
    name: string,
    existing: PluginRecord | undefined,
    noop: boolean,
    dryRun: boolean,
    mcpEnabled: boolean,
): PluginInstallPreview {
    const pkg = prepared.package;
    return {
        name,
        layout: pkg.layout,
        ...(pkg.version === undefined ? {} : { version: pkg.version }),
        ...(pkg.description === undefined ? {} : { description: pkg.description }),
        source_path: pkg.directory,
        directory: join(paths.plugins_directory, name),
        digest: prepared.snapshot.digest,
        entries: prepared.snapshot.entries,
        total_bytes: prepared.snapshot.total_bytes,
        enabled: existing?.enabled ?? true,
        replaces: existing === undefined || noop
            ? null
            : { name: existing.name, source_path: existing.source.path },
        dry_run: dryRun,
        components: pkg.components,
        mcp: mapPluginMcpServers({
            plugin: name,
            directory: pkg.directory,
            dataDirectory: pluginDataDirectoryIn(paths.vera_home, name),
            entries: pkg.components.mcp_servers,
        }),
        mcp_enabled: mcpEnabled,
        ignored: pkg.ignored,
        warnings: pkg.warnings,
    };
}

function buildRecord(
    pkg: LoadedPluginPackage,
    name: string,
    sourcePath: string,
    snapshot: DirectorySnapshot,
    enabled: boolean,
): PluginRecord {
    const roots = (values: readonly string[]): readonly string[] =>
        [...new Set(values.map((value) => relative(pkg.directory, value).split(sep).join("/")))];
    return {
        name,
        ...(pkg.version === undefined ? {} : { version: pkg.version }),
        ...(pkg.description === undefined ? {} : { description: pkg.description }),
        source: { kind: "local", path: sourcePath },
        digest: snapshot.digest,
        entries: snapshot.entries,
        total_bytes: snapshot.total_bytes,
        newest_mtime_ms: snapshot.newest_mtime_ms,
        directory: `plugins/${name}`,
        enabled,
        installed_at: new Date().toISOString(),
        components: {
            ...summarizePluginComponents(pkg.components),
            skill_roots: roots(pkg.components.skills.map((skill) => skill.root)),
            agent_roots: roots(pkg.components.agents.map((agent) => agent.root)),
        },
        ignored: pkg.ignored,
    };
}

function installDirectory(
    pluginsDirectory: string,
    name: string,
    staging: string,
    document: PluginRegistryDocument,
    registryPath: string,
): void {
    const destination = join(pluginsDirectory, name);
    const tombstone = join(
        pluginsDirectory,
        `.replaced-${name}-${process.pid}-${randomUUID()}`,
    );
    let moved = false;
    if (directoryExists(destination) || pathExists(destination)) {
        assertNotSymlink(destination, "Plugin folder");
        renameSync(destination, tombstone);
        moved = true;
    }
    try {
        renameSync(staging, destination);
    } catch (error) {
        if (moved) renameSync(tombstone, destination);
        throw error;
    }
    try {
        writePluginRegistry(registryPath, document);
    } catch (error) {
        rmSync(destination, { recursive: true, force: true });
        if (moved) renameSync(tombstone, destination);
        throw error;
    }
    rmSync(tombstone, { recursive: true, force: true });
}

function findRecord(registry: PluginRegistryDocument, name: string): PluginRecord {
    const record = registry.plugins.find((entry) => entry.name === name);
    if (record === undefined) {
        throw new PluginManagerError(`No plugin named ${name} is installed.`);
    }
    return record;
}

function directoryExists(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

function pathExists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function assertNotSymlink(path: string, label: string): void {
    if (lstatSync(path).isSymbolicLink()) {
        throw new PluginManagerError(`${label} is a symlink: ${path}`);
    }
}

function mcpServersEnabled(home: string): boolean {
    try {
        const config = loadOptionalVeraConfig({
            path: defaultVeraConfigPath(home),
        });
        return isIncludedExtensionOn(
            "vera.mcp",
            config?.disabled_included_extensions ?? [],
        );
    } catch {
        return true;
    }
}

function pluginError(message: string): Error {
    return new PluginManagerError(message);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
