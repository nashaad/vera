import { lstatSync } from "node:fs";
import { join, relative } from "node:path";

import {
    pluginDataDirectoryIn,
    pluginDirectoryIn,
    pluginRegistryPathIn,
    pluginsDirectoryIn,
    veraProfileDirectory,
} from "../profile-paths.ts";
import {
    assertSafePluginData,
    assertSafePluginStore,
    readPluginRegistry,
    type PluginRecord,
} from "./registry.ts";
import {
    loadPluginPackage,
    type LoadedPluginPackage,
} from "./manifest.ts";
import { mapPluginMcpServers, type PluginMcpServer } from "./mcp.ts";
import { extensionServesHost, loadExtensionManifest } from "../extensions/manifest.ts";
import type { JsonValue } from "../sdk/hooks.ts";

export interface PluginRoot {
    readonly plugin: string;
    readonly path: string;
}

export interface PluginCatalog {
    readonly plugins: readonly PluginRecord[];
    readonly skill_roots: readonly PluginRoot[];
    readonly agent_roots: readonly PluginRoot[];
    readonly warnings: readonly string[];
}

export interface PluginCatalogOptions {
    /** A user home; the Vera home is `<home>/.vera`. */
    readonly home?: string;
    /** The Vera home itself; takes precedence over `home`. */
    readonly veraHome?: string;
}

function veraHomeFor(options: PluginCatalogOptions): string {
    return options.veraHome
        ?? veraProfileDirectory(process.env, options.home);
}

// Reads machine/plugins.json only: no package is hashed and no code runs.
export function readPluginCatalog(
    options: PluginCatalogOptions = {},
): PluginCatalog {
    const veraHome = veraHomeFor(options);
    const pluginsDirectory = pluginsDirectoryIn(veraHome);
    const registryPath = pluginRegistryPathIn(veraHome);
    let plugins: readonly PluginRecord[];
    try {
        assertSafePluginStore(pluginsDirectory, registryPath);
        plugins = readPluginRegistry(registryPath).plugins;
    } catch (error) {
        return {
            plugins: [],
            skill_roots: [],
            agent_roots: [],
            warnings: [`Plugins: ${errorMessage(error)}`],
        };
    }

    const warnings: string[] = [];
    const skillRoots: PluginRoot[] = [];
    const agentRoots: PluginRoot[] = [];
    for (const record of plugins.toSorted((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        if (!record.enabled) continue;
        const directory = pluginDirectoryIn(veraHome, record.name);
        let details;
        try {
            details = lstatSync(directory);
        } catch {
            warnings.push(`plugin ${record.name}: the installed folder is missing`);
            continue;
        }
        if (details.isSymbolicLink() || !details.isDirectory()) {
            warnings.push(`plugin ${record.name}: the installed folder is not a directory`);
            continue;
        }
        collectRoots(record, "skill_roots", directory, skillRoots, warnings);
        collectRoots(record, "agent_roots", directory, agentRoots, warnings);
    }
    return {
        plugins: plugins.toSorted((left, right) =>
            left.name.localeCompare(right.name)
        ),
        skill_roots: skillRoots,
        agent_roots: agentRoots,
        warnings,
    };
}

function collectRoots(
    record: PluginRecord,
    field: "skill_roots" | "agent_roots",
    packageDirectory: string,
    roots: PluginRoot[],
    warnings: string[],
): void {
    for (const relativeRoot of record.components[field]) {
        const path = join(packageDirectory, relativeRoot);
        const offset = relative(packageDirectory, path);
        if (offset.startsWith("..") || offset === "") {
            warnings.push(
                `plugin ${record.name}: ${field.replace("_", " ")} ${relativeRoot} leaves the plugin`,
            );
            continue;
        }
        let details;
        try {
            details = lstatSync(path);
        } catch {
            warnings.push(
                `plugin ${record.name}: ${field.replace("_", " ")} ${relativeRoot} is missing`,
            );
            continue;
        }
        if (details.isSymbolicLink() || !details.isDirectory()) {
            warnings.push(
                `plugin ${record.name}: ${field.replace("_", " ")} ${relativeRoot} is not a directory`,
            );
            continue;
        }
        roots.push({ plugin: record.name, path });
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** What the host reads from the plugin store once at start. */
export interface PluginHostExtensionPart {
    readonly plugin: string;
    readonly id: string;
    readonly directory: string;
    readonly package_identity: PluginPackageIdentity;
    readonly enabled: boolean;
    readonly startup_config?: JsonValue;
    readonly serves_host: boolean;
    readonly provides_model_middleware: boolean;
}

export interface PluginHostExtensionOwner {
    readonly plugin: string;
    readonly id: string;
}

export interface PluginPackageIdentity {
    readonly directory: string;
    readonly dev: string;
    readonly ino: string;
}

export interface PluginWorkerExtensionEntry {
    readonly plugin: string;
    readonly id: string;
    readonly directory: string;
    readonly package_identity: PluginPackageIdentity;
    readonly enabled: boolean;
    readonly config: JsonValue;
}

export interface PluginWorkerExtensions {
    readonly entries: readonly PluginWorkerExtensionEntry[];
    readonly owners: readonly PluginHostExtensionOwner[];
}

export interface PluginSnapshot {
    readonly vera_home: string | null;
    /** Enabled records, in plugin name order. */
    readonly plugins: readonly PluginRecord[];
    /** Mapped MCP servers from enabled plugins, in plugin then server order. */
    readonly mcp_servers: readonly PluginMcpServer[];
    /** Host extension code shipped in enabled plugins, in plugin name order. */
    readonly host_extensions: readonly PluginHostExtensionPart[];
    /** Recorded host IDs, including plugins that are off. */
    readonly host_extension_owners: readonly PluginHostExtensionOwner[];
    readonly warnings: readonly string[];
}

export function emptyPluginSnapshot(): PluginSnapshot {
    return {
        vera_home: null,
        plugins: [],
        mcp_servers: [],
        host_extensions: [],
        host_extension_owners: [],
        warnings: [],
    };
}

export function workerPluginSnapshot(
    veraHome: string,
    workerExtensions?: PluginWorkerExtensions,
): PluginSnapshot {
    const hostExtensions: PluginHostExtensionPart[] = [];
    const warnings: string[] = [];
    for (const entry of workerExtensions?.entries ?? []) {
        if (!entry.enabled) continue;
        const packageWarning = pluginPackageWarning(entry.plugin, entry.package_identity);
        if (packageWarning !== undefined) {
            warnings.push(packageWarning);
            continue;
        }
        let servesHost = true;
        let providesModelMiddleware = false;
        try {
            const manifest = loadExtensionManifest(entry.directory).manifest;
            if (manifest.id !== entry.id) {
                warnings.push(
                    `plugin ${entry.plugin}: host extension id ${manifest.id} differs from `
                        + `the recorded id ${entry.id}; install the plugin again from its source`,
                );
                continue;
            }
            servesHost = extensionServesHost(manifest);
            providesModelMiddleware = manifest.capabilities.includes("hooks.model_middleware");
        } catch {
            // The extension registry reports an unreadable manifest.
        }
        hostExtensions.push({
            plugin: entry.plugin,
            id: entry.id,
            directory: entry.directory,
            package_identity: entry.package_identity,
            enabled: entry.enabled,
            startup_config: entry.config,
            serves_host: servesHost,
            provides_model_middleware: providesModelMiddleware,
        });
    }
    return {
        ...emptyPluginSnapshot(),
        vera_home: veraHome,
        host_extensions: hostExtensions,
        host_extension_owners: workerExtensions?.owners ?? [],
        warnings,
    };
}

export function pluginPackageWarning(
    plugin: string,
    identity: PluginPackageIdentity,
): string | undefined {
    try {
        const details = lstatSync(identity.directory, { bigint: true });
        if (details.isDirectory()
            && details.dev.toString() === identity.dev
            && details.ino.toString() === identity.ino) return undefined;
    } catch {}
    return `plugin ${plugin}: the installed package changed or is unavailable; `
        + "restart the host to load the new version";
}

interface EnabledPackage {
    readonly record: PluginRecord;
    readonly directory: string;
    readonly package_identity: PluginPackageIdentity;
    readonly package: LoadedPluginPackage;
}

interface EnabledPackages {
    readonly records: readonly PluginRecord[];
    readonly installed: readonly PluginRecord[];
    readonly packages: readonly EnabledPackage[];
    readonly warnings: readonly string[];
}

function readEnabledPackages(veraHome: string): EnabledPackages {
    const pluginsDirectory = pluginsDirectoryIn(veraHome);
    const registryPath = pluginRegistryPathIn(veraHome);
    let plugins: readonly PluginRecord[];
    try {
        assertSafePluginStore(pluginsDirectory, registryPath);
        plugins = readPluginRegistry(registryPath).plugins;
    } catch (error) {
        return {
            records: [],
            installed: [],
            packages: [],
            warnings: [`Plugins: ${errorMessage(error)}`],
        };
    }

    const installed = plugins.toSorted((left, right) => left.name.localeCompare(right.name));
    const enabled = installed.filter((record) => record.enabled);
    const warnings: string[] = [];
    const packages: EnabledPackage[] = [];
    for (const record of enabled) {
        const directory = pluginDirectoryIn(veraHome, record.name);
        let details;
        try {
            details = lstatSync(directory, { bigint: true });
        } catch {
            warnings.push(`plugin ${record.name}: the installed folder is missing`);
            continue;
        }
        if (details.isSymbolicLink() || !details.isDirectory()) {
            warnings.push(`plugin ${record.name}: the installed folder is not a directory`);
            continue;
        }
        let loaded;
        try {
            loaded = loadPluginPackage(directory);
        } catch (error) {
            warnings.push(
                `plugin ${record.name}: the package could not be read: ${errorMessage(error)}`,
            );
            continue;
        }
        for (const warning of loaded.warnings) {
            warnings.push(`plugin ${record.name}: ${warning}`);
        }
        packages.push({
            record,
            directory,
            package: loaded,
            package_identity: {
                directory: loaded.directory,
                dev: details.dev.toString(),
                ino: details.ino.toString(),
            },
        });
    }
    return {
        records: enabled,
        installed,
        packages,
        warnings,
    };
}

export function readPluginSnapshot(
    options: PluginCatalogOptions = {},
): PluginSnapshot {
    const veraHome = veraHomeFor(options);
    const pluginsDirectory = pluginsDirectoryIn(veraHome);
    const {
        records,
        installed,
        packages,
        warnings: packageWarnings,
    } = readEnabledPackages(veraHome);

    const warnings = [...packageWarnings];
    const servers: PluginMcpServer[] = [];
    const hostExtensions: PluginHostExtensionPart[] = [];
    for (const { record, directory, package: loaded, package_identity } of packages) {
        const host = loaded.components.host_extension;
        if (host !== null) {
            const recordedId = record.components.host_extension;
            if (host.id !== recordedId) {
                warnings.push(
                    `plugin ${record.name}: host extension id ${host.id} differs from `
                        + `the recorded id ${recordedId ?? "(none)"}; `
                        + "install the plugin again from its source",
                );
            } else {
                hostExtensions.push({
                    plugin: record.name,
                    id: host.id,
                    directory: host.directory,
                    package_identity,
                    enabled: record.enabled,
                    serves_host: host.serves_host,
                    provides_model_middleware: host.capabilities.includes("hooks.model_middleware"),
                });
            }
        }
        try {
            assertSafePluginData(pluginsDirectory, record.name);
        } catch (error) {
            warnings.push(`plugin ${record.name}: ${errorMessage(error)}`);
            continue;
        }
        const mapped = mapPluginMcpServers({
            plugin: record.name,
            directory,
            dataDirectory: pluginDataDirectoryIn(veraHome, record.name),
            entries: loaded.components.mcp_servers,
            createDataDirectory: true,
        });
        servers.push(...mapped.servers);
        for (const skip of mapped.skipped) {
            warnings.push(
                `plugin ${skip.plugin}: MCP server ${skip.name} was skipped: ${skip.reason}`,
            );
        }
    }
    return {
        vera_home: veraHome,
        plugins: records,
        mcp_servers: servers,
        host_extensions: hostExtensions,
        host_extension_owners: installed.flatMap((record) =>
            record.components.host_extension === null
                ? []
                : [{ plugin: record.name, id: record.components.host_extension }]
        ),
        warnings,
    };
}

export interface PluginDesktopPart {
    readonly plugin: string;
    readonly id: string;
    readonly directory: string;
}

export interface PluginDesktopParts {
    readonly parts: readonly PluginDesktopPart[];
    readonly warnings: readonly string[];
}

/** Enabled plugins' desktop parts, read by the desktop store on each scan. */
export function readPluginDesktopParts(
    options: PluginCatalogOptions = {},
): PluginDesktopParts {
    const veraHome = veraHomeFor(options);
    const { packages, warnings } = readEnabledPackages(veraHome);
    const parts: PluginDesktopPart[] = [];
    for (const { record, package: loaded } of packages) {
        const desktop = loaded.components.desktop_extension;
        if (desktop === null) continue;
        parts.push({
            plugin: record.name,
            id: desktop.id,
            directory: desktop.directory,
        });
    }
    return { parts, warnings };
}
