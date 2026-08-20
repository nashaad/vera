import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { VeraExtensionConfig } from "../config.ts";
import {
    loadExtensionManifest,
} from "./manifest.ts";
import { veraProfileDirectory } from "../profile-paths.ts";

export const EXTENSION_REGISTRY_SCHEMA_VERSION = 1;

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
    return join(resolve(projectRoot), ".vera", "extensions");
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

export function readExtensionRegistry(
    directory: string,
    registryPath = join(dirname(directory), "extensions.json"),
): ExtensionRegistryDocument {
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
    const parsed = parseRegistry(value, directory);
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
    const registry = readExtensionRegistry(directory, registryPath);
    return registry.extensions.map((record) => ({
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
    const sourcePath = resolve(source);
    const loaded = loadExtensionManifest(sourcePath);
    const registry = readExtensionRegistry(directory, registryPath);
    const existing = registry.extensions.find((record) =>
        record.id === loaded.manifest.id
    );
    if (existing !== undefined) {
        throw new ExtensionManagerError(
            `Extension ${loaded.manifest.id} is already installed in the ${target.scope} scope`,
        );
    }

    const destination = join(directory, loaded.manifest.id);
    if (existsSync(destination)) {
        throw new ExtensionManagerError(
            `Extension destination already exists: ${destination}`,
        );
    }
    const digest = digestExtensionDirectory(loaded.directory);
    const preview: ExtensionInstallPreview = {
        scope: target.scope,
        ...(target.scope === "project"
            ? { projectRoot: requireProjectRoot(target) }
            : {}),
        id: loaded.manifest.id,
        version: loaded.manifest.version,
        source: sourcePath,
        destination,
        digest,
        capabilities: loaded.manifest.capabilities,
        dryRun: options.dryRun === true,
    };
    if (options.dryRun === true) return { preview };

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staging = join(
        directory,
        `.staging-${loaded.manifest.id}-${process.pid}-${Date.now()}`,
    );
    const record: ManagedExtensionRecord = {
        id: loaded.manifest.id,
        version: loaded.manifest.version,
        source: { kind: "local", path: sourcePath },
        digest,
        directory: join("extensions", loaded.manifest.id),
        enabled: true,
        installedAt: new Date().toISOString(),
    };
    try {
        cpSync(loaded.directory, staging, {
            recursive: true,
            errorOnExist: true,
            force: false,
        });
        const staged = loadExtensionManifest(staging);
        if (staged.manifest.id !== record.id) {
            throw new ExtensionManagerError(
                `Staged extension changed ID from ${record.id} to ${staged.manifest.id}`,
            );
        }
        if (digestExtensionDirectory(staged.directory) !== digest) {
            throw new ExtensionManagerError(
                `Extension ${record.id} changed while it was being staged`,
            );
        }
        renameSync(staging, destination);
        try {
            writeExtensionRegistry(directory, registryPath, {
                schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
                extensions: [...registry.extensions, record],
            });
        } catch (error) {
            rmSync(destination, { recursive: true, force: true });
            throw error;
        }
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        if (error instanceof ExtensionManagerError) throw error;
        throw new ExtensionManagerError(
            `Could not install extension ${record.id}: ${errorMessage(error)}`,
        );
    }
    return { preview, record };
}

export function setExtensionEnabled(
    id: string,
    enabled: boolean,
    target: ExtensionManagerTarget,
    options: ExtensionManagerOptions = {},
): ManagedExtensionRecord {
    const directory = extensionDirectoryFor(target, options);
    const registryPath = extensionRegistryPathFor(target, options);
    const registry = readExtensionRegistry(directory, registryPath);
    const record = registry.extensions.find((entry) => entry.id === id);
    if (record === undefined) {
        throw new ExtensionManagerError(
            `No managed extension named ${id} exists in the ${target.scope} scope`,
        );
    }
    const path = extensionPath(directory, record);
    if (!existsSync(path)) {
        throw new ExtensionManagerError(
            `Managed extension ${id} is missing from ${path}`,
        );
    }
    const updated = { ...record, enabled };
    writeExtensionRegistry(directory, registryPath, {
        schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
        extensions: registry.extensions.map((entry) =>
            entry.id === id ? updated : entry
        ),
    });
    return updated;
}

export function removeExtension(
    id: string,
    target: ExtensionManagerTarget,
    options: ExtensionManagerOptions = {},
): ManagedExtensionRecord {
    const directory = extensionDirectoryFor(target, options);
    const registryPath = extensionRegistryPathFor(target, options);
    const registry = readExtensionRegistry(directory, registryPath);
    const record = registry.extensions.find((entry) => entry.id === id);
    if (record === undefined) {
        throw new ExtensionManagerError(
            `No managed extension named ${id} exists in the ${target.scope} scope`,
        );
    }
    const path = extensionPath(directory, record);
    if (!existsSync(path)) {
        throw new ExtensionManagerError(
            `Managed extension ${id} is missing from ${path}`,
        );
    }

    const tombstone = `${path}.removing-${process.pid}-${Date.now()}`;
    renameSync(path, tombstone);
    try {
        writeExtensionRegistry(directory, registryPath, {
            schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION,
            extensions: registry.extensions.filter((entry) => entry.id !== id),
        });
    } catch (error) {
        renameSync(tombstone, path);
        throw error;
    }
    rmSync(tombstone, { recursive: true, force: true });
    return record;
}

export function listExtensions(
    options: ExtensionManagerOptions & { readonly projectRoot?: string } = {},
): readonly ExtensionListEntry[] {
    const targets: readonly ExtensionManagerTarget[] = [
        { scope: "profile" },
        ...(options.projectRoot === undefined
            ? []
            : [{ scope: "project" as const, projectRoot: options.projectRoot }]),
    ];
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
    const registry = readExtensionRegistry(directory, registryPath);
    const managedPaths = new Set<string>();
    const entries: ExtensionListEntry[] = [];
    for (const record of registry.extensions) {
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
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const ordered = [...registry.extensions].toSorted((left, right) =>
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
}

function parseRegistry(
    value: unknown,
    directory: string,
): ExtensionRegistryDocument | undefined {
    if (!isRecord(value) || value.schema_version !== EXTENSION_REGISTRY_SCHEMA_VERSION) {
        return undefined;
    }
    if (!Array.isArray(value.extensions)) return undefined;
    const extensions: ManagedExtensionRecord[] = [];
    for (const item of value.extensions) {
        if (!isRecord(item)) return undefined;
        const source = isRecord(item.source) ? item.source : undefined;
        if (
            typeof item.id !== "string"
            || typeof item.version !== "string"
            || typeof item.digest !== "string"
            || typeof item.directory !== "string"
            || typeof item.enabled !== "boolean"
            || typeof item.installedAt !== "string"
            || source === undefined
            || source.kind !== "local"
            || typeof source.path !== "string"
            || !isRelativeExtensionDirectory(item.directory)
        ) {
            return undefined;
        }
        const record = {
            id: item.id,
            version: item.version,
            source: { kind: "local" as const, path: source.path },
            digest: item.digest,
            directory: item.directory,
            enabled: item.enabled,
            installedAt: item.installedAt,
        } satisfies ManagedExtensionRecord;
        const resolved = extensionPath(directory, record);
        if (!isWithin(directory, resolved)) {
            return undefined;
        }
        if (extensions.some((entry) => entry.id === record.id)) return undefined;
        extensions.push(record);
    }
    return { schema_version: EXTENSION_REGISTRY_SCHEMA_VERSION, extensions };
}

function extensionPath(
    directory: string,
    record: Pick<ManagedExtensionRecord, "directory">,
): string {
    return resolve(dirname(directory), record.directory);
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
    return resolve(target.projectRoot);
}

function isDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

function isRelativeExtensionDirectory(path: string): boolean {
    return path.startsWith(`extensions${sep}`)
        && !path.split(sep).includes("..")
        && !path.startsWith("/")
        && !path.endsWith(sep);
}

function isWithin(directory: string, candidate: string): boolean {
    const path = relative(resolve(directory), resolve(candidate));
    return path === ""
        || (path !== ".."
            && !path.startsWith(`..${sep}`)
            && !path.includes(`${sep}..${sep}`)
            && !path.startsWith("/"));
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
            hash.update(`symlink:${relativePath}:${readlinkTarget(path)}\n`);
        } else {
            throw new ExtensionManagerError(
                `Unsupported file in extension source: ${path}`,
            );
        }
    }
}

function readlinkTarget(path: string): string {
    return readlinkSync(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
