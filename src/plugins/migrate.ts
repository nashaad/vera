import { randomUUID } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { inspectDirectory, withFileLock } from "../store/managed-directory.ts";
import { includedExtensionIds } from "../extensions/included.ts";
import { pluginDirectoryIn, pluginRegistryPathIn, pluginsDirectoryIn } from "../profile-paths.ts";
import { summarizePluginComponents } from "./components.ts";
import { hasLegacyExtensionStores, legacyStoreWasMigrated } from "./migrate-startup.ts";
import {
    assertSafeLegacyBoundaries,
    collectLegacyParts,
    legacyStores,
    readLegacyConfig,
    renameLegacyStores,
    rewriteLegacyConfig,
    type LegacyPart,
} from "./migrate-legacy.ts";
import { PLUGIN_PACKAGE_LIMITS, pluginStorePaths, type PluginManagerOptions } from "./manager.ts";
import { loadPluginPackage } from "./manifest.ts";
import { AGENT_PLUGIN_SCHEMA, MAX_PLUGIN_NAME_CHARACTERS, portablePluginName } from "./naming.ts";
import {
    assertSafePluginStore,
    MAX_PLUGINS,
    readPluginRegistry,
    writePluginRegistry,
    type PluginRecord,
} from "./registry.ts";

export interface PluginMigrationReport {
    readonly migrated: readonly string[];
    readonly skipped: readonly string[];
    readonly failures: readonly string[];
    readonly rollback: readonly string[];
    readonly config_rewritten: boolean;
}

export interface MigratedHostPath {
    readonly from: string;
    readonly to: string;
}

export interface PluginMigrationOutcome {
    readonly report: PluginMigrationReport;
    readonly host_paths: readonly MigratedHostPath[];
}

export function migratePlugins(options: PluginManagerOptions = {}): PluginMigrationReport {
    return migratePluginsIn(pluginStorePaths(options).vera_home).report;
}

export function migratePluginsIn(veraHome: string): PluginMigrationOutcome {
    const paths = {
        vera_home: veraHome,
        plugins_directory: pluginsDirectoryIn(veraHome),
        registry_path: pluginRegistryPathIn(veraHome),
    };
    const stores = legacyStores(paths.vera_home);
    const report = { migrated: [] as string[], skipped: [] as string[], failures: [] as string[],
        rollback: [] as string[], config_rewritten: false };
    if (!hasLegacyExtensionStores(paths.vera_home)) {
        return { report, host_paths: [] };
    }
    assertSafePluginStore(paths.plugins_directory, paths.registry_path);
    const destinations = new Map<string, string>();
    const result = withFileLock(`${paths.registry_path}.lock`, () => {
        assertSafePluginStore(paths.plugins_directory, paths.registry_path);
        assertSafeLegacyBoundaries(stores);
        const selected = {
            host: !legacyStoreWasMigrated(stores.hostDirectory),
            desktop: !legacyStoreWasMigrated(stores.desktopDirectory),
        };
        if (!selected.host && !selected.desktop) return report;
        const registry = readPluginRegistry(paths.registry_path);
        let records = [...registry.plugins];
        const created: { path: string; createdFolder: boolean }[] = [];
        const originalNames = new Set(records.filter((record) => record.source.kind !== "migration").map((record) => record.name));
        const config = selected.host ? readLegacyConfig(stores.configPath) : undefined;
        const parts = collectLegacyParts(stores, config, report.failures, selected);
        const duplicateKeys = new Set<string>();
        const seen = new Set<string>();
        for (const part of parts) {
            const key = `${part.kind}:${part.id}`;
            if (seen.has(key)) duplicateKeys.add(key);
            seen.add(key);
        }
        for (const key of duplicateKeys) report.failures.push(`duplicate legacy extension ${key}`);
        const pending = parts.filter((part) => {
            if (duplicateKeys.has(`${part.kind}:${part.id}`)) return false;
            const match = records.find((record) => part.kind === "host"
                ? record.components.host_extension === part.id
                : record.components.desktop_extension === part.id);
            if (match === undefined) return true;
            const root = pluginDirectoryIn(paths.vera_home, match.name);
            try {
                const pkg = loadPluginPackage(root);
                const found = part.kind === "host" ? pkg.components.host_extension : pkg.components.desktop_extension;
                if (found?.id !== part.id) throw new Error("recorded part is missing");
                if (part.kind === "host") destinations.set(part.path, found.directory);
                report.skipped.push(`${part.kind} ${part.id}: already in plugin ${match.name}`);
            } catch (error) {
                report.failures.push(`${part.kind} ${part.id}: recorded plugin ${match.name}: ${errorMessage(error)}`);
            }
            return false;
        });
        const hostIds = new Set(parts.filter((part) => part.kind === "host").map((part) => part.id));
        const includedIds = new Set(includedExtensionIds());
        const used = new Set<LegacyPart>();
        for (const part of pending) {
            if (used.has(part)) continue;
            const partner = pending.find((other) => other.kind !== part.kind && other.id === part.id
                && other.enabled === part.enabled && !used.has(other));
            const group = partner === undefined ? [part] : [part, partner];
            group.forEach((entry) => used.add(entry));
            const host = group.find((entry) => entry.kind === "host");
            if (host !== undefined && includedIds.has(host.id)) {
                report.failures.push(`host ${host.id}: an included extension uses this id`);
                continue;
            }
            const desktopSplit = part.kind === "desktop" && partner === undefined && hostIds.has(part.id);
            const base = portablePluginName(part.id);
            if (base === undefined) {
                report.failures.push(`${part.kind} ${part.id}: cannot form a plugin name`);
                continue;
            }
            const preferred = desktopSplit ? withSuffix(base, "-desktop") : base;
            if (originalNames.has(preferred)) {
                report.failures.push(`${part.kind} ${part.id}: plugin name ${preferred} is already installed`);
                continue;
            }
            let name = preferred;
            for (let index = 2; records.some((record) => record.name === name); index += 1) {
                name = withSuffix(preferred, `-${index}`);
            }
            try {
                if (records.length >= MAX_PLUGINS) throw new Error(`Vera keeps at most ${MAX_PLUGINS} plugins`);
                const copied = copyGroup(name, group, paths.vera_home, paths.plugins_directory,
                    paths.registry_path, records);
                records = [...records, copied.record];
                created.push({ path: pluginDirectoryIn(paths.vera_home, name), createdFolder: copied.createdFolder });
                const host = group.find((entry) => entry.kind === "host");
                if (host !== undefined) destinations.set(host.path, join(pluginDirectoryIn(paths.vera_home, name), "host"));
                report.migrated.push(`${group.map((entry) => `${entry.kind} ${entry.id}${entry.enabled ? "" : " (off)"}`).join(", ")} -> ${name}`);
            } catch (error) {
                report.failures.push(`${group.map((entry) => `${entry.kind} ${entry.id}`).join(", ")}: ${errorMessage(error)}`);
            }
        }
        try {
            const configResult = rewriteLegacyConfig(stores, config, destinations);
            report.config_rewritten = configResult.changed;
            report.failures.push(...configResult.unresolved);
        } catch (error) {
            report.failures.push(`Config rewrite failed: ${errorMessage(error)}`);
            if (created.length > 0) {
                try {
                    writePluginRegistry(paths.registry_path, registry);
                    for (const entry of created) {
                        if (entry.createdFolder) rmSync(entry.path, { recursive: true, force: true });
                        const destination = join(entry.path, "host");
                        for (const [source, target] of destinations) {
                            if (target === destination) destinations.delete(source);
                        }
                    }
                    report.migrated.length = 0;
                } catch (rollbackError) {
                    report.failures.push(`Could not roll back newly migrated plugins: ${errorMessage(rollbackError)}`);
                }
            }
            return report;
        }
        if (report.failures.length === 0) {
            try {
                report.rollback.push(...renameLegacyStores(stores, selected));
            } catch (error) {
                report.failures.push(errorMessage(error));
            }
        }
        return report;
    });
    return {
        report: result,
        host_paths: [...destinations].map(([from, to]) => ({ from, to })),
    };
}

export function renderPluginMigration(report: PluginMigrationReport): string {
    const lines = [
        ...report.migrated.map((entry) => `Migrated ${entry}.`),
        ...report.skipped.map((entry) => `Skipped ${entry}.`),
        ...report.failures.map((entry) => `Not migrated: ${entry}.`),
        ...(report.config_rewritten ? ["Updated extension paths in config.json."] : []),
        ...report.rollback.map((entry) => `Rollback copy: ${entry}`),
    ];
    if (lines.length === 0) lines.push("No legacy extensions to migrate.");
    if (report.failures.length > 0) lines.push("Legacy stores remain active; fix the reported problems and retry.");
    else if (report.migrated.length > 0) lines.push("Restart the host and desktop to load migrated extensions.");
    return `${lines.join("\n")}\n`;
}

function copyGroup(
    name: string,
    group: readonly LegacyPart[],
    home: string,
    pluginsDirectory: string,
    registryPath: string,
    records: readonly PluginRecord[],
): { readonly record: PluginRecord; readonly createdFolder: boolean } {
    mkdirSync(pluginsDirectory, { recursive: true, mode: 0o700 });
    const staging = join(pluginsDirectory, `.staging-migrate-${randomUUID()}`);
    const destination = pluginDirectoryIn(home, name);
    let moved = false;
    try {
        mkdirSync(staging, { mode: 0o700 });
        const declarations: Record<string, string> = {};
        for (const part of group) {
            if (!lstatSync(part.path).isDirectory()) throw new Error(`Source is not a directory: ${part.path}`);
            const before = inspectDirectory(part.path, PLUGIN_PACKAGE_LIMITS, pluginError);
            const target = join(staging, part.kind);
            cpSync(part.path, target, { recursive: true, errorOnExist: true, force: false });
            const copied = inspectDirectory(target, PLUGIN_PACKAGE_LIMITS, pluginError);
            const after = inspectDirectory(part.path, PLUGIN_PACKAGE_LIMITS, pluginError);
            if (before.digest !== copied.digest || before.digest !== after.digest) {
                throw new Error(`Extension changed while it was copied: ${part.path}`);
            }
            declarations[part.kind === "host" ? "extension" : "desktop"] = `./${part.kind}`;
        }
        writeFileSync(join(staging, "plugin.json"), `${JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name, extensions: { "dev.vera": declarations },
        }, null, 2)}\n`, { mode: 0o600 });
        let snapshot = inspectDirectory(staging, PLUGIN_PACKAGE_LIMITS, pluginError);
        const pkg = loadPluginPackage(staging);
        for (const part of group) {
            const found = part.kind === "host" ? pkg.components.host_extension : pkg.components.desktop_extension;
            if (found?.id !== part.id) throw new Error(`${part.kind} extension could not be loaded: ${pkg.warnings.join("; ")}`);
        }
        const roots = (values: readonly string[]): readonly string[] => [...new Set(values.map((value) =>
            relative(pkg.directory, value).split(sep).join("/")))];
        if (pathExists(destination)) {
            if (!lstatSync(destination).isDirectory()) throw new Error(`Plugin folder already exists: ${destination}`);
            const existing = inspectDirectory(destination, PLUGIN_PACKAGE_LIMITS, pluginError);
            if (existing.digest !== snapshot.digest) throw new Error(`Plugin folder already exists: ${destination}`);
            snapshot = existing;
        } else {
            renameSync(staging, destination);
            moved = true;
        }
        const record: PluginRecord = {
            name,
            source: { kind: "migration", path: group[0]!.path },
            ...snapshot,
            directory: `plugins/${name}`,
            enabled: group.some((part) => part.enabled),
            installed_at: new Date().toISOString(),
            components: {
                ...summarizePluginComponents(pkg.components),
                skill_roots: roots(pkg.components.skills.map((skill) => skill.root)),
                agent_roots: roots(pkg.components.agents.map((agent) => agent.root)),
            },
            ignored: pkg.ignored,
        };
        try {
            writePluginRegistry(registryPath, { schema_version: 1, plugins: [...records, record] });
        } catch (error) {
            if (moved) rmSync(destination, { recursive: true, force: true });
            throw error;
        }
        return { record, createdFolder: moved };
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

function withSuffix(name: string, suffix: string): string {
    return `${name.slice(0, MAX_PLUGIN_NAME_CHARACTERS - suffix.length).replace(/[^a-z0-9]+$/, "")}${suffix}`;
}

function pathExists(path: string): boolean {
    try { lstatSync(path); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function pluginError(message: string): Error { return new Error(message); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
