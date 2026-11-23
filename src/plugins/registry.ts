import { randomUUID } from "node:crypto";
import {
    lstatSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { isPortablePluginName } from "./naming.ts";

export const PLUGIN_REGISTRY_SCHEMA_VERSION = 1;
export const PLUGIN_REGISTRY_MAX_BYTES = 256 * 1024;
export const MAX_PLUGINS = 200;

export class PluginManagerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PluginManagerError";
    }
}

export interface PluginSource {
    readonly kind: "local" | "migration";
    readonly path: string;
}

export interface PluginComponentsRecord {
    readonly skills: readonly string[];
    readonly agents: readonly string[];
    readonly mcp_servers: readonly string[];
    readonly skill_roots: readonly string[];
    readonly agent_roots: readonly string[];
    readonly host_extension: string | null;
    readonly desktop_extension: string | null;
}

export interface PluginRecord {
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
    readonly source: PluginSource;
    readonly digest: string;
    readonly entries: number;
    readonly total_bytes: number;
    readonly newest_mtime_ms: number;
    readonly directory: string;
    readonly enabled: boolean;
    readonly installed_at: string;
    readonly components: PluginComponentsRecord;
    readonly ignored: readonly string[];
}

export interface PluginRegistryDocument {
    readonly schema_version: 1;
    readonly plugins: readonly PluginRecord[];
}

export function emptyPluginRegistry(): PluginRegistryDocument {
    return { schema_version: PLUGIN_REGISTRY_SCHEMA_VERSION, plugins: [] };
}

export function readPluginRegistry(path: string): PluginRegistryDocument {
    assertNotSymlink(path, "Plugin registry");
    let details;
    try {
        details = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return emptyPluginRegistry();
        }
        throw new PluginManagerError(
            `Plugin registry could not be read at ${path}: ${errorMessage(error)}`,
        );
    }
    // A FIFO or device here would block or stream instead of holding one document.
    if (!details.isFile()) {
        throw new PluginManagerError(
            `Plugin registry is not a regular file: ${path}`,
        );
    }
    let source: string;
    try {
        const size = statSync(path).size;
        if (size > PLUGIN_REGISTRY_MAX_BYTES) {
            throw new PluginManagerError(
                `Plugin registry at ${path} is larger than ${PLUGIN_REGISTRY_MAX_BYTES} bytes`,
            );
        }
        source = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return emptyPluginRegistry();
        }
        if (error instanceof PluginManagerError) throw error;
        throw new PluginManagerError(
            `Plugin registry could not be read at ${path}: ${errorMessage(error)}`,
        );
    }
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch (error) {
        throw new PluginManagerError(
            `Plugin registry at ${path} is not valid JSON: ${errorMessage(error)}`,
        );
    }
    return parsePluginRegistry(value, path);
}

export function writePluginRegistry(
    path: string,
    document: PluginRegistryDocument,
): void {
    const validated = parsePluginRegistry(
        JSON.parse(JSON.stringify(document)),
        path,
    );
    const sorted: PluginRegistryDocument = {
        schema_version: PLUGIN_REGISTRY_SCHEMA_VERSION,
        plugins: [...validated.plugins].toSorted((left, right) =>
            left.name.localeCompare(right.name)
        ),
    };
    const text = `${JSON.stringify(sorted, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > PLUGIN_REGISTRY_MAX_BYTES) {
        throw new PluginManagerError(
            `Plugin registry would be larger than ${PLUGIN_REGISTRY_MAX_BYTES} bytes`,
        );
    }
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
        writeFileSync(temporary, text, {
            encoding: "utf8",
            mode: 0o600,
        });
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

export function parsePluginRegistry(
    value: unknown,
    path: string,
): PluginRegistryDocument {
    const fail = (problem: string): never => {
        throw new PluginManagerError(
            `Plugin registry at ${path} is invalid: ${problem}`,
        );
    };
    if (!isRecord(value)) return fail("expected an object");
    if (value.schema_version !== PLUGIN_REGISTRY_SCHEMA_VERSION) {
        return fail(`unsupported schema_version ${String(value.schema_version)}`);
    }
    if (!Array.isArray(value.plugins)) return fail("plugins must be an array");
    if (value.plugins.length > MAX_PLUGINS) {
        return fail(`at most ${MAX_PLUGINS} plugins are kept`);
    }
    const names = new Set<string>();
    const plugins = value.plugins.map((entry, index) => {
        const record = parsePluginRecord(entry, `plugins[${index}]`, fail);
        if (names.has(record.name)) return fail(`duplicate plugin name ${record.name}`);
        names.add(record.name);
        return record;
    });
    return { schema_version: PLUGIN_REGISTRY_SCHEMA_VERSION, plugins };
}

function parsePluginRecord(
    value: unknown,
    label: string,
    fail: (problem: string) => never,
): PluginRecord {
    if (!isRecord(value)) return fail(`${label} must be an object`);
    const name = value.name;
    if (typeof name !== "string" || !isPortablePluginName(name)) {
        return fail(`${label}.name is not a valid plugin name`);
    }
    const version = value.version;
    if (
        version !== undefined
        && (typeof version !== "string" || version.trim().length === 0)
    ) {
        return fail(`${label}.version must be a non-empty string`);
    }
    const description = value.description;
    if (description !== undefined && typeof description !== "string") {
        return fail(`${label}.description must be a string`);
    }
    const source = value.source;
    if (
        !isRecord(source)
        || (source.kind !== "local" && source.kind !== "migration")
        || typeof source.path !== "string"
        || source.path.length === 0
    ) {
        return fail(`${label}.source must name a local or migration path`);
    }
    const digest = value.digest;
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
        return fail(`${label}.digest is not a sha256 digest`);
    }
    const entries = value.entries;
    if (!Number.isInteger(entries) || (entries as number) < 0) {
        return fail(`${label}.entries is not an entry count`);
    }
    const totalBytes = value.total_bytes;
    if (!Number.isInteger(totalBytes) || (totalBytes as number) < 0) {
        return fail(`${label}.total_bytes is not a byte count`);
    }
    const newestMtime = value.newest_mtime_ms;
    if (typeof newestMtime !== "number" || !Number.isFinite(newestMtime) || newestMtime < 0) {
        return fail(`${label}.newest_mtime_ms is not a timestamp`);
    }
    if (value.directory !== `plugins/${name}`) {
        return fail(`${label}.directory must be plugins/${name}`);
    }
    if (typeof value.enabled !== "boolean") {
        return fail(`${label}.enabled must be a boolean`);
    }
    if (
        typeof value.installed_at !== "string"
        || Number.isNaN(Date.parse(value.installed_at))
    ) {
        return fail(`${label}.installed_at is not a timestamp`);
    }
    const components = value.components;
    if (!isRecord(components)) return fail(`${label}.components must be an object`);
    const stringArray = (entry: unknown, field: string): readonly string[] => {
        if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string")) {
            return fail(`${label}.components.${field} must be an array of strings`);
        }
        return entry as string[];
    };
    const rootArray = (entry: unknown, field: string): readonly string[] => {
        const roots = stringArray(entry, field);
        for (const root of roots) {
            if (
                root.length === 0
                || isAbsolute(root)
                || root.split("/").includes("..")
            ) {
                return fail(`${label}.components.${field} has a path outside the package`);
            }
        }
        return roots;
    };
    const optionalId = (entry: unknown, field: string): string | null => {
        if (entry === null || entry === undefined) return null;
        if (typeof entry !== "string" || entry.length === 0) {
            return fail(`${label}.components.${field} must be an id or null`);
        }
        return entry;
    };
    const ignored = value.ignored;
    if (!Array.isArray(ignored) || ignored.some((item) => typeof item !== "string")) {
        return fail(`${label}.ignored must be an array of strings`);
    }
    return {
        name,
        ...(version === undefined ? {} : { version }),
        ...(description === undefined ? {} : { description }),
        source: { kind: source.kind, path: source.path },
        digest,
        entries: entries as number,
        total_bytes: totalBytes as number,
        newest_mtime_ms: newestMtime,
        directory: `plugins/${name}`,
        enabled: value.enabled,
        installed_at: value.installed_at,
        components: {
            skills: stringArray(components.skills, "skills"),
            agents: stringArray(components.agents, "agents"),
            mcp_servers: stringArray(components.mcp_servers, "mcp_servers"),
            skill_roots: rootArray(components.skill_roots, "skill_roots"),
            agent_roots: rootArray(components.agent_roots, "agent_roots"),
            host_extension: optionalId(components.host_extension, "host_extension"),
            desktop_extension: optionalId(
                components.desktop_extension,
                "desktop_extension",
            ),
        },
        ignored: ignored as string[],
    };
}

export function assertSafePluginStore(
    pluginsDirectory: string,
    registryPath: string,
): void {
    const home = dirname(pluginsDirectory);
    const machineDirectory = join(home, "machine");
    assertNotSymlink(home, "Vera home");
    assertNotSymlink(pluginsDirectory, "Plugins directory");
    assertNotSymlink(join(pluginsDirectory, ".data"), "Plugin data directory");
    assertNotSymlink(machineDirectory, "Vera machine directory");
    assertNotSymlink(registryPath, "Plugin registry");
    if (dirname(registryPath) !== machineDirectory) {
        throw new PluginManagerError(
            `Plugin registry must live in machine/ in the Vera home: ${registryPath}`,
        );
    }
}

export function assertSafePluginData(
    pluginsDirectory: string,
    name: string,
): void {
    assertNotSymlink(join(pluginsDirectory, ".data"), "Plugin data directory");
    assertNotSymlink(
        join(pluginsDirectory, ".data", name),
        "Plugin data directory",
    );
}

function assertNotSymlink(path: string, label: string): void {
    try {
        if (lstatSync(path).isSymbolicLink()) {
            throw new PluginManagerError(`${label} is a symlink: ${path}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
