import { posix } from "node:path";

import { isReleaseVersion } from "./version.ts";

export const DESKTOP_PACKAGE_LAYOUT_VERSION = 1;
export const DESKTOP_PACKAGE_MANIFEST_NAME = "desktop-package.json";

export interface DesktopPackageManifest {
    readonly layout_version: number;
    readonly desktop_version: string;
    readonly host_build_id: string;
    // Path of the file the shell loads, relative to the package root.
    readonly entry: string;
}

function fail(field: string, detail: string): never {
    throw new Error(`Desktop package manifest ${field}: ${detail}`);
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        fail(field, "must be a non-empty string");
    }
    return value;
}

// Build ids and versions become directory names, so neither may name a path.
export function isSafeHostBuildId(value: string): boolean {
    return value.length > 0
        && !value.startsWith(".")
        && !/[\\/\0]/.test(value);
}

function isSafeEntry(value: string): boolean {
    if (value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) return false;
    const normalized = posix.normalize(value);
    return normalized === value && normalized !== "." && !normalized.startsWith("../") && normalized !== "..";
}

export function serializeDesktopPackageManifest(manifest: DesktopPackageManifest): string {
    return `${JSON.stringify({
        layout_version: manifest.layout_version,
        desktop_version: manifest.desktop_version,
        host_build_id: manifest.host_build_id,
        entry: manifest.entry,
    }, null, 2)}\n`;
}

export function parseDesktopPackageManifest(text: string): DesktopPackageManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Desktop package manifest is not JSON: ${reason}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail("root", "must be an object");
    }
    const record = parsed as Record<string, unknown>;
    if (record.layout_version !== DESKTOP_PACKAGE_LAYOUT_VERSION) {
        fail(
            "layout_version",
            `unsupported ${String(record.layout_version)}, expected ${DESKTOP_PACKAGE_LAYOUT_VERSION}`,
        );
    }
    const desktopVersion = requiredString(record.desktop_version, "desktop_version");
    if (!isReleaseVersion(desktopVersion)) {
        fail("desktop_version", `'${desktopVersion}' is not a version like 0.1.0`);
    }
    const hostBuildId = requiredString(record.host_build_id, "host_build_id");
    if (!isSafeHostBuildId(hostBuildId)) {
        fail("host_build_id", `'${hostBuildId}' cannot name a directory`);
    }
    const entry = requiredString(record.entry, "entry");
    if (!isSafeEntry(entry)) {
        fail("entry", `'${entry}' must be a plain relative path inside the package`);
    }
    return {
        layout_version: DESKTOP_PACKAGE_LAYOUT_VERSION,
        desktop_version: desktopVersion,
        host_build_id: hostBuildId,
        entry,
    };
}
