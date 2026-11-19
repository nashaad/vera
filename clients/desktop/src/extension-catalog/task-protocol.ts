import { isAbsolute } from "node:path";

import { EXTENSION_ID_PATTERN, MAX_ID_LENGTH } from "../../../ui/src/extensions/manifest.ts";
import { MAX_PACKAGE_BYTES } from "../extensions/limits.ts";

// The main process imports only this file from this folder; the rest is network code for the task process.

export const CATALOG_TASK_SERVICE = "Vera Extension Catalog";
export const CATALOG_TASK_FILE = "extension-catalog.cjs";

export const CATALOG_UNREACHABLE = "Vera could not reach the catalog.";
export const DOWNLOAD_FAILED = "Vera could not download that package.";

export const MAX_CATALOG_BYTES = 1024 * 1024;
export const MAX_CATALOG_ENTRIES = 500;
export const PALETTE_SIZE = 5;
const MAX_URL_CHARS = 2048;
const MAX_NAME_CHARS = 120;
const MAX_VERSION_CHARS = 64;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PALETTE_COLOR = /^#[0-9a-f]{6}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

// What the catalog says about one theme package. The task has already dropped withdrawn entries and entries for another engine.
export interface CatalogEntry {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly url: string;
    readonly sha256: string;
    readonly size: number;
    readonly palette: readonly string[];
}

// Fetches the catalog at `url`; `engine` is the one this build runs.
export interface CatalogListTask {
    readonly kind: "list";
    readonly url: string;
    readonly engine: string;
}

// Fetches one package into a new file at `destination`, which must be exactly `size` bytes. Checking the sha256 is the
// install task's first step, before anything is unpacked.
export interface CatalogDownloadTask {
    readonly kind: "download";
    readonly url: string;
    readonly size: number;
    readonly destination: string;
}

export type CatalogTask = CatalogListTask | CatalogDownloadTask;

export type CatalogReply =
    | { readonly ok: true; readonly kind: "list"; readonly entries: readonly CatalogEntry[] }
    | { readonly ok: true; readonly kind: "download"; readonly bytes: number }
    | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isPackageSize(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_PACKAGE_BYTES;
}

// Only http and https are fetched.
export function isCatalogUrl(value: unknown): value is string {
    if (!isString(value) || value.length === 0 || value.length > MAX_URL_CHARS) return false;
    try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

export function parseCatalogEntry(value: unknown): CatalogEntry | undefined {
    if (!isRecord(value)) return undefined;
    const { id, name, version, url, sha256, size, palette } = value;
    if (!isString(id) || id.length > MAX_ID_LENGTH || !EXTENSION_ID_PATTERN.test(id)) return undefined;
    if (!isString(name) || name.length === 0 || name.length > MAX_NAME_CHARS || CONTROL_CHARACTERS.test(name)) return undefined;
    if (!isString(version) || version.length > MAX_VERSION_CHARS || !VERSION_PATTERN.test(version)) return undefined;
    if (!isCatalogUrl(url) || !isString(sha256) || !SHA256_PATTERN.test(sha256) || !isPackageSize(size)) return undefined;
    if (!Array.isArray(palette) || palette.length !== PALETTE_SIZE) return undefined;
    const colors: string[] = [];
    for (const color of palette) {
        if (!isString(color) || !PALETTE_COLOR.test(color)) return undefined;
        colors.push(color);
    }
    return { id, name, version, url, sha256, size, palette: colors };
}

export function parseCatalogTask(value: unknown): CatalogTask | undefined {
    if (!isRecord(value)) return undefined;
    if (value.kind === "list") {
        const { url, engine } = value;
        return isCatalogUrl(url) && isString(engine) ? { kind: "list", url, engine } : undefined;
    }
    if (value.kind === "download") {
        const { url, size, destination } = value;
        if (!isCatalogUrl(url) || !isPackageSize(size) || !isString(destination) || !isAbsolute(destination)) return undefined;
        return { kind: "download", url, size, destination };
    }
    return undefined;
}

export function parseCatalogReply(value: unknown): CatalogReply | undefined {
    if (!isRecord(value)) return undefined;
    if (value.ok === false) return isString(value.reason) ? { ok: false, reason: value.reason } : undefined;
    if (value.ok !== true) return undefined;
    if (value.kind === "download") {
        const { bytes } = value;
        return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? { ok: true, kind: "download", bytes } : undefined;
    }
    if (value.kind !== "list" || !Array.isArray(value.entries) || value.entries.length > MAX_CATALOG_ENTRIES) return undefined;
    const entries: CatalogEntry[] = [];
    for (const raw of value.entries) {
        const entry = parseCatalogEntry(raw);
        if (entry === undefined) return undefined;
        entries.push(entry);
    }
    return { ok: true, kind: "list", entries };
}
