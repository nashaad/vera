import {
    readFileSync,
    realpathSync,
    statSync,
} from "node:fs";
import {
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";

export const EXTENSION_MANIFEST_FILENAME = "vera.extension.json";
export const VERA_EXTENSION_SDK_VERSION = "1";

export interface ExtensionManifest {
    readonly id: string;
    readonly version: string;
    readonly sdk: typeof VERA_EXTENSION_SDK_VERSION;
    readonly entrypoint: string;
    readonly capabilities: readonly string[];
}

export interface LoadedExtensionManifest {
    readonly directory: string;
    readonly manifestPath: string;
    readonly entrypointPath: string;
    readonly manifest: ExtensionManifest;
}

export function loadExtensionManifest(
    configuredDirectory: string,
): LoadedExtensionManifest {
    const directory = realDirectory(configuredDirectory);
    const manifestPath = realFileWithin(
        directory,
        join(directory, EXTENSION_MANIFEST_FILENAME),
        "manifest",
    );
    const value = readJson(manifestPath);
    const manifest = parseExtensionManifest(value);
    if (manifest === undefined) {
        throw new Error(
            `Invalid Vera extension manifest at ${manifestPath}`,
        );
    }

    const entrypointPath = realEntrypoint(directory, manifest.entrypoint);
    return {
        directory,
        manifestPath,
        entrypointPath,
        manifest,
    };
}

export function parseExtensionManifest(
    value: unknown,
): ExtensionManifest | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }

    const capabilities = parseCapabilities(value.capabilities);
    if (
        typeof value.id !== "string"
        || !isExtensionId(value.id)
        || typeof value.version !== "string"
        || value.version.trim().length === 0
        || value.sdk !== VERA_EXTENSION_SDK_VERSION
        || typeof value.entrypoint !== "string"
        || value.entrypoint.trim().length === 0
        || isAbsolute(value.entrypoint)
        || capabilities === undefined
    ) {
        return undefined;
    }

    return {
        id: value.id,
        version: value.version.trim(),
        sdk: VERA_EXTENSION_SDK_VERSION,
        entrypoint: value.entrypoint,
        capabilities,
    };
}

function realDirectory(configuredDirectory: string): string {
    let directory: string;
    try {
        directory = realpathSync(resolve(configuredDirectory));
    } catch (error) {
        throw new Error(
            `Vera extension directory is unavailable at ${configuredDirectory}: ${errorMessage(error)}`,
        );
    }

    if (!statSync(directory).isDirectory()) {
        throw new Error(`Vera extension path is not a directory: ${directory}`);
    }
    return directory;
}

function realEntrypoint(directory: string, entrypoint: string): string {
    const candidate = resolve(directory, entrypoint);
    if (!isWithin(directory, candidate)) {
        throw new Error(
            `Vera extension entrypoint leaves its directory: ${entrypoint}`,
        );
    }

    return realFileWithin(directory, candidate, "entrypoint");
}

function realFileWithin(
    directory: string,
    candidate: string,
    kind: "manifest" | "entrypoint",
): string {
    let path: string;
    try {
        path = realpathSync(candidate);
    } catch (error) {
        throw new Error(
            `Vera extension ${kind} is unavailable at ${candidate}: ${errorMessage(error)}`,
        );
    }

    if (!isWithin(directory, path) || !statSync(path).isFile()) {
        throw new Error(
            `Vera extension ${kind} must be a file inside ${directory}`,
        );
    }
    return path;
}

function readJson(path: string): unknown {
    let source: string;
    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        throw new Error(
            `Vera extension manifest is unavailable at ${path}: ${errorMessage(error)}`,
        );
    }

    try {
        return JSON.parse(source);
    } catch (error) {
        throw new Error(
            `Invalid JSON in Vera extension manifest at ${path}: ${errorMessage(error)}`,
        );
    }
}

function parseCapabilities(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const capabilities = value.map((capability) =>
        typeof capability === "string" ? capability.trim() : ""
    );
    if (
        capabilities.some((capability) => capability.length === 0)
        || new Set(capabilities).size !== capabilities.length
    ) {
        return undefined;
    }
    return capabilities;
}

function isExtensionId(value: string): boolean {
    return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

function isWithin(directory: string, candidate: string): boolean {
    const path = relative(directory, candidate);
    return path === ""
        || (path !== ".."
            && !path.startsWith(`..${sep}`)
            && !isAbsolute(path));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
