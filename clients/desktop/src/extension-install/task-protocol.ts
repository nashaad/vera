import { isAbsolute } from "node:path";

// The main process imports only this file from this folder; the rest is install code for the task process.

export const EXTENSION_TASK_SERVICE = "Vera Extension Install";
export const EXTENSION_TASK_FILE = "extension-install.cjs";

export interface InstallTask {
    readonly kind: "install";
    // The gzip tar package, and its sha256 in hex when the caller knows what it should be.
    readonly packagePath: string;
    readonly sha256?: string;
    // An empty folder the package is unpacked into. The task leaves it in place for main to install or delete.
    readonly staging: string;
}

export interface InstallPreview {
    readonly id: string;
    readonly version: string;
    readonly themes: readonly string[];
    readonly hasMain: boolean;
    readonly hasCommands: boolean;
}

export type InstallReply =
    | { readonly ok: true; readonly preview: InstallPreview }
    | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function parsePreview(value: unknown): InstallPreview | undefined {
    if (!isRecord(value)) return undefined;
    const { id, version, themes, hasMain, hasCommands } = value;
    if (!isString(id) || !isString(version) || !Array.isArray(themes) || !themes.every(isString)) return undefined;
    if (typeof hasMain !== "boolean" || typeof hasCommands !== "boolean") return undefined;
    return { id, version, themes, hasMain, hasCommands };
}

export function parseInstallTask(value: unknown): InstallTask | undefined {
    if (!isRecord(value) || value.kind !== "install") return undefined;
    const { packagePath, sha256, staging } = value;
    if (!isString(packagePath) || !isAbsolute(packagePath) || !isString(staging) || !isAbsolute(staging)) return undefined;
    if (sha256 !== undefined && !isString(sha256)) return undefined;
    return { kind: "install", packagePath, ...(sha256 === undefined ? {} : { sha256 }), staging };
}

export function parseInstallReply(value: unknown): InstallReply | undefined {
    if (!isRecord(value)) return undefined;
    if (value.ok === false) return isString(value.reason) ? { ok: false, reason: value.reason } : undefined;
    const preview = value.ok === true ? parsePreview(value.preview) : undefined;
    return preview === undefined ? undefined : { ok: true, preview };
}
