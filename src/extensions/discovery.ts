import {
    existsSync,
    readdirSync,
    realpathSync,
    type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import {
    join,
    resolve,
} from "node:path";

import type { VeraExtensionConfig } from "../config.ts";
import {
    EXTENSION_MANIFEST_FILENAME,
    loadExtensionManifest,
} from "./manifest.ts";
import { veraProfileDirectory } from "../profile-paths.ts";
import {
    assertSafeExtensionDirectory,
    managedExtensionConfigs,
} from "./manager.ts";

export function defaultVeraExtensionDirectory(): string {
    return join(veraProfileDirectory(), "extensions");
}

export function discoverExtensionConfigs(
    directory = defaultVeraExtensionDirectory(),
): readonly VeraExtensionConfig[] {
    assertSafeExtensionDirectory(directory);
    let entries: Dirent[];
    try {
        entries = readdirSync(directory, {
            encoding: "utf8",
            withFileTypes: true,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }

    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => resolve(directory, entry.name))
        .filter((path) =>
            existsSync(join(path, EXTENSION_MANIFEST_FILENAME))
        )
        .map((path) => ({
            path,
            enabled: true,
            config: {},
        }));
}

export function discoverManagedExtensionConfigs(
    directory: string,
): readonly VeraExtensionConfig[] {
    assertSafeExtensionDirectory(directory);
    return managedExtensionConfigs(directory);
}

export function mergeExtensionScopes(
    profile: readonly VeraExtensionConfig[],
    project: readonly VeraExtensionConfig[],
): readonly VeraExtensionConfig[] {
    const projectIds = new Set(
        project.map((extension) => extensionIdentity(extension)),
    );
    return [
        ...profile.filter((extension) =>
            !projectIds.has(extensionIdentity(extension))
        ),
        ...project,
    ];
}

export function mergeExtensionConfigs(
    discovered: readonly VeraExtensionConfig[],
    configured: readonly VeraExtensionConfig[],
): readonly VeraExtensionConfig[] {
    const configuredPaths = new Set(
        configured.map((extension) => canonicalPath(extension.path)),
    );
    return [
        ...discovered.filter((extension) =>
            !configuredPaths.has(canonicalPath(extension.path))
        ),
        ...configured,
    ];
}

function canonicalPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

function extensionIdentity(extension: VeraExtensionConfig): string {
    try {
        return `id:${loadExtensionManifest(extension.path).manifest.id}`;
    } catch {
        return `path:${canonicalPath(extension.path)}`;
    }
}
