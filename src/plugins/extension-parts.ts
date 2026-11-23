import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { extensionServesHost, loadExtensionManifest } from "../extensions/manifest.ts";
import type {
    PluginDesktopComponent,
    PluginHostComponent,
} from "./components.ts";
import { errorMessage, isDirectory, isFile, isWithin, readJsonObject } from "./package-files.ts";
import {
    DESKTOP_EXTENSION_MANIFEST_FILENAME,
    HOST_EXTENSION_MANIFEST_FILENAME,
    PLUGIN_MANIFEST_MAX_BYTES,
} from "./naming.ts";

const DESKTOP_ENGINE = "vera-gui@^1";
const DESKTOP_ID_PATTERN = /^[a-z0-9-](?:[a-z0-9.-]*[a-z0-9-])?$/;
const DESKTOP_MAX_ID_LENGTH = 80;

export function loadHostExtension(
    configuredDirectory: string,
    packageRoot: string,
    warnings: string[],
    declared = false,
): {
    readonly component: PluginHostComponent;
    readonly skill_roots: readonly string[];
} | undefined {
    if (!isDirectory(configuredDirectory)) {
        if (declared) {
            warnings.push(`host extension is missing: ${configuredDirectory}`);
        }
        return undefined;
    }
    if (!isFile(join(configuredDirectory, HOST_EXTENSION_MANIFEST_FILENAME))) {
        if (declared) {
            warnings.push(
                `host extension: ${HOST_EXTENSION_MANIFEST_FILENAME} is missing`,
            );
        }
        return undefined;
    }
    const realDirectory = realpathSync(configuredDirectory);
    if (!isWithin(packageRoot, realDirectory)) {
        warnings.push(`host extension leaves the plugin: ${configuredDirectory}`);
        return undefined;
    }
    try {
        const loaded = loadExtensionManifest(realDirectory);
        if (!isWithin(packageRoot, loaded.directory)) {
            warnings.push(`host extension leaves the plugin: ${loaded.directory}`);
            return undefined;
        }
        return {
            component: {
                id: loaded.manifest.id,
                version: loaded.manifest.version,
                capabilities: loaded.manifest.capabilities,
                serves_host: extensionServesHost(loaded.manifest),
                directory: loaded.directory,
                manifest_path: loaded.manifestPath,
            },
            skill_roots: loaded.manifest.contributes.skills.map((root) =>
                join(loaded.directory, root)
            ),
        };
    } catch (error) {
        warnings.push(`host extension: ${errorMessage(error)}`);
        return undefined;
    }
}

export function loadDesktopExtension(
    configuredDirectory: string,
    packageRoot: string,
    warnings: string[],
    declared = false,
): PluginDesktopComponent | undefined {
    if (!isDirectory(configuredDirectory)) {
        if (declared) {
            warnings.push(`desktop extension is missing: ${configuredDirectory}`);
        }
        return undefined;
    }
    const manifestPath = join(configuredDirectory, DESKTOP_EXTENSION_MANIFEST_FILENAME);
    if (!isFile(manifestPath)) {
        if (declared) {
            warnings.push(
                `desktop extension: ${DESKTOP_EXTENSION_MANIFEST_FILENAME} is missing`,
            );
        }
        return undefined;
    }
    const realDirectory = realpathSync(configuredDirectory);
    if (!isWithin(packageRoot, realDirectory)) {
        warnings.push(`desktop extension leaves the plugin: ${configuredDirectory}`);
        return undefined;
    }
    try {
        const value = readJsonObject(
            manifestPath,
            PLUGIN_MANIFEST_MAX_BYTES,
            DESKTOP_EXTENSION_MANIFEST_FILENAME,
        );
        const id = value.id;
        if (
            typeof id !== "string"
            || !DESKTOP_ID_PATTERN.test(id)
            || id.length > DESKTOP_MAX_ID_LENGTH
        ) {
            throw new Error("invalid id");
        }
        if (typeof value.version !== "string" || value.version.trim().length === 0) {
            throw new Error("version must be a non-empty string");
        }
        if (value.engine !== DESKTOP_ENGINE) {
            throw new Error(`engine must be ${DESKTOP_ENGINE}`);
        }
        return {
            id,
            version: value.version.trim(),
            directory: realDirectory,
            manifest_path: manifestPath,
        };
    } catch (error) {
        warnings.push(`desktop extension: ${errorMessage(error)}`);
        return undefined;
    }
}

export function noteIgnoredPath(
    directory: string,
    relativePath: string,
    ignored: string[],
    reason: string,
): void {
    const path = join(directory, relativePath);
    let present = false;
    try {
        lstatSync(path);
        present = true;
    } catch {
        present = false;
    }
    if (present) ignored.push(`ignored: ${relativePath} (${reason})`);
}
