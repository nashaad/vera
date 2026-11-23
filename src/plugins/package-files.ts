import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { PluginManifestError } from "./errors.ts";

export function readJsonObject(
    path: string,
    maxBytes: number,
    label: string,
): Record<string, unknown> {
    let details;
    try {
        details = lstatSync(path);
    } catch (error) {
        throw new PluginManifestError(`${label} is unavailable: ${errorMessage(error)}`);
    }
    if (!details.isFile()) {
        throw new PluginManifestError(`${label} must be a regular file`);
    }
    if (details.size > maxBytes) {
        throw new PluginManifestError(`${label} is larger than ${maxBytes} bytes`);
    }
    let source: string;
    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        throw new PluginManifestError(
            `${label} could not be read: ${errorMessage(error)}`,
        );
    }
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch (error) {
        throw new PluginManifestError(
            `${label} is not valid JSON: ${errorMessage(error)}`,
        );
    }
    if (!isPlainObject(value)) {
        throw new PluginManifestError(`${label} must be an object`);
    }
    return value;
}

export function isFile(path: string): boolean {
    try {
        return lstatSync(path).isFile();
    } catch {
        return false;
    }
}

export function isDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value);
}

export function isWithin(directory: string, candidate: string): boolean {
    const path = relative(directory, candidate);
    return path === ""
        || (path !== ".."
            && !path.startsWith(`..${sep}`)
            && !isAbsolute(path));
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
