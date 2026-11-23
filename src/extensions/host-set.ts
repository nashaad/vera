import { isAbsolute, relative, resolve, sep } from "node:path";

import type { VeraConfig, VeraExtensionConfig } from "../config.ts";
import { pluginPackageWarning, type PluginSnapshot } from "../plugins/catalog.ts";
import { RESERVED_MCP_SERVER_NAMES } from "../plugins/mcp.ts";
import { createHostLogger, defaultHostLogPath } from "../host/host-log.ts";
import { mergeExtensionScopes } from "./discovery.ts";
import { includedExtensions } from "./included.ts";
import { isIncludedExtensionOn } from "./included-state.ts";
import { extensionServesHost, loadExtensionManifest } from "./manifest.ts";
import type { ExtensionRegistryFailure } from "./registry.ts";
import { canonicalExtensionPath as canonicalPath, withoutPluginExtensionPaths } from "./plugin-paths.ts";

export interface HostExtensionConfigSet {
    readonly extensions: readonly VeraExtensionConfig[];
    /** Plugin conflicts reported in the host startup log. */
    readonly warnings: readonly string[];
    readonly failures: readonly ExtensionRegistryFailure[];
}

/** The set a host runs in its main process. */
export function hostExtensionConfigs(
    config: Pick<VeraConfig, "disabled_included_extensions" | "extensions">,
    plugins: PluginSnapshot,
): readonly VeraExtensionConfig[] {
    return hostExtensionConfigSet(config, plugins).extensions;
}

export function hostExtensionConfigSet(
    config: Pick<VeraConfig, "disabled_included_extensions" | "extensions">,
    plugins: PluginSnapshot,
): HostExtensionConfigSet {
    const configured = config.extensions ?? [];
    const configuredByPath = new Map(configured.map((entry) => [canonicalPath(entry.path), entry]));
    const hostOwners = new Map(plugins.host_extension_owners.map((owner) => [owner.id, owner.plugin]));
    const pluginPaths = new Set(plugins.host_extensions.map((part) => canonicalPath(part.directory)));
    const warnings: string[] = [];
    const regular = withoutPluginExtensionPaths(configured, plugins.vera_home).filter((entry) => {
        const path = canonicalPath(entry.path);
        if (pluginPaths.has(path)) return false;
        if (plugins.vera_home !== null && isLegacyExtension(plugins.vera_home, entry.path, path)) {
            const id = manifestId(entry.path);
            const owner = id === undefined ? undefined : hostOwners.get(id);
            if (id !== undefined && owner !== undefined) {
                warnings.push(
                    `legacy extension ${id} at ${entry.path} was skipped: `
                        + `plugin ${owner} holds the same host extension id`,
                );
                return false;
            }
        }
        return true;
    });
    const included = includedExtensions();
    const includedConfigs = included
        .filter((extension) => extension.id === undefined || isIncludedExtensionOn(
            extension.id,
            config.disabled_included_extensions ?? [],
        ))
        .map((extension) => ({ path: extension.path, enabled: true, config: {} }));
    const extensions = mergeExtensionScopes(includedConfigs, regular);
    const reserved = new Set(included.flatMap((extension) => extension.id === undefined ? [] : [extension.id]));
    const priorIds = new Set<string>();
    if (plugins.host_extensions.some((part) => reserved.has(part.id))) {
        for (const entry of extensions) {
            if (!entry.enabled) continue;
            try {
                const manifest = loadExtensionManifest(entry.path).manifest;
                if (extensionServesHost(manifest)) priorIds.add(manifest.id);
            } catch {
                continue;
            }
        }
    }
    const failures: ExtensionRegistryFailure[] = [];
    const pluginExtensions = plugins.host_extensions.flatMap((part) => {
        const match = configuredByPath.get(canonicalPath(part.directory));
        if (reserved.has(part.id) && !priorIds.has(part.id)) {
            failures.push({
                path: part.directory,
                extensionId: part.id,
                message: `Duplicate extension ID: ${part.id}`,
            });
            return [];
        }
        return [{
            path: part.directory,
            enabled: part.enabled,
            config: part.startup_config === undefined
                ? match === undefined ? {} : match.config
                : part.startup_config,
        }];
    });
    const composed = composePluginMcpServers([...extensions, ...pluginExtensions], config, plugins);
    return { extensions: composed.extensions, warnings: [...warnings, ...composed.warnings], failures };
}

/**
 * The set a worker runs: configured extensions as before, plus only included
 * extensions whose manifest provides model middleware.
 */
const warnedWorkerPackages = new WeakMap<PluginSnapshot, Set<string>>();

export function workerExtensionConfigs(
    config: Pick<VeraConfig, "disabled_included_extensions" | "extensions">,
    plugins: PluginSnapshot,
    onWarning?: (message: string) => void,
): readonly VeraExtensionConfig[] {
    const configured = new Set(
        (config.extensions ?? []).map((extension) =>
            canonicalPath(extension.path)
        ),
    );
    const pluginPaths = new Map(plugins.host_extensions.map((part) => [canonicalPath(part.directory), part]));
    return hostExtensionConfigs(config, plugins).filter((extension) => {
        const path = canonicalPath(extension.path);
        const part = pluginPaths.get(path);
        if (part !== undefined) {
            if (!part.provides_model_middleware) return false;
            const warning = pluginPackageWarning(part.plugin, part.package_identity);
            if (warning !== undefined) {
                warnWorkerPackageOnce(plugins, part.plugin, warning, onWarning);
                return false;
            }
            return true;
        }
        return configured.has(path) || providesModelMiddleware(extension.path);
    });
}

function warnWorkerPackageOnce(
    plugins: PluginSnapshot,
    plugin: string,
    warning: string,
    onWarning?: (message: string) => void,
): void {
    let warned = warnedWorkerPackages.get(plugins);
    if (warned?.has(plugin)) return;
    if (onWarning !== undefined) {
        onWarning(warning);
    } else if (plugins.vera_home !== null) {
        const log = createHostLogger({ path: defaultHostLogPath(plugins.vera_home) });
        if (!log({ type: "host_startup_plugin_warning", message: warning })) return;
    } else {
        return;
    }
    if (warned === undefined) {
        warned = new Set();
        warnedWorkerPackages.set(plugins, warned);
    }
    warned.add(plugin);
}

function composePluginMcpServers(
    extensions: readonly VeraExtensionConfig[],
    config: Pick<VeraConfig, "disabled_included_extensions">,
    plugins: PluginSnapshot,
): Pick<HostExtensionConfigSet, "extensions" | "warnings"> {
    if (
        plugins.mcp_servers.length === 0
        || !isIncludedExtensionOn(
            "vera.mcp",
            config.disabled_included_extensions ?? [],
        )
    ) {
        return { extensions, warnings: [] };
    }
    const index = extensions.findIndex((extension) =>
        manifestId(extension.path) === "vera.mcp"
    );
    if (index < 0) {
        return { extensions, warnings: [] };
    }
    const entry = extensions[index]!;
    if (!isPlainObject(entry.config)) {
        return {
            extensions,
            warnings: [
                "vera.mcp config is not an object; plugin MCP servers were not added",
            ],
        };
    }
    const homeServers = entry.config.servers;
    if (homeServers !== undefined && !isPlainObject(homeServers)) {
        return {
            extensions,
            warnings: [
                "vera.mcp config `servers` is not an object; plugin MCP servers were not added",
            ],
        };
    }
    const servers: Record<string, unknown> = { ...homeServers };
    const owners = new Map<string, string>(
        Object.keys(servers).map((name) => [name, "the home config"]),
    );
    const warnings: string[] = [];
    for (const server of plugins.mcp_servers) {
        if (RESERVED_MCP_SERVER_NAMES.has(server.name)) {
            warnings.push(
                `MCP server ${server.name} from plugin ${server.plugin} was skipped: `
                    + "the name is reserved",
            );
            continue;
        }
        const owner = owners.get(server.name);
        if (owner !== undefined || Object.hasOwn(servers, server.name)) {
            warnings.push(
                `MCP server ${server.name} from plugin ${server.plugin} was skipped: `
                    + `${owner ?? "the home config"} already defines it`,
            );
            continue;
        }
        Object.defineProperty(servers, server.name, {
            value: server.config,
            enumerable: true,
            configurable: true,
            writable: true,
        });
        owners.set(server.name, `plugin ${server.plugin}`);
    }
    const composed: VeraExtensionConfig = {
        ...entry,
        config: {
            ...entry.config,
            servers,
        } as VeraExtensionConfig["config"],
    };
    return {
        extensions: extensions.map((candidate, position) =>
            position === index ? composed : candidate
        ),
        warnings,
    };
}

function manifestId(path: string): string | undefined {
    try {
        return loadExtensionManifest(path).manifest.id;
    } catch {
        return undefined;
    }
}

function isPlainObject(
    value: unknown,
): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providesModelMiddleware(path: string): boolean {
    try {
        return loadExtensionManifest(path).manifest.capabilities.includes(
            "hooks.model_middleware",
        );
    } catch {
        // A manifest that does not load is the host registry's failure to report.
        return false;
    }
}

function isLegacyExtension(home: string, configuredPath: string, canonical: string): boolean {
    return [
        relative(resolve(home), resolve(configuredPath)),
        relative(canonicalPath(home), canonical),
    ].some((offset) => {
        const parts = offset.split(sep);
        return !isAbsolute(offset) && parts.length > 1 && parts[0] === "extensions";
    });
}
