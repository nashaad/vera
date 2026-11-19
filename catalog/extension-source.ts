import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DESKTOP_MANIFEST_FILENAME } from "../clients/ui/src/extensions/manifest.ts";
import { parseImportedTheme } from "../clients/ui/src/theme/imported.ts";
import { COLOR_TOKENS, type ColorToken } from "../clients/ui/src/theme/tokens.ts";
import { carriesCode, readExtension } from "../clients/desktop/src/extensions/read-extension.ts";
import { fail } from "./build-error.ts";

// The colors of a catalog card's five swatches, in the order the catalog lists them.
const PALETTE_TOKENS = ["surface", "text", "accent", "success", "danger"] as const satisfies readonly ColorToken[];
const VERSION = /^\d+\.\d+\.\d+$/;

export interface ExtensionSource {
    readonly id: string;
    // The label of the extension's first theme.
    readonly name: string;
    readonly version: string;
    readonly palette: readonly string[];
    // The files a package holds, by path inside the extension.
    readonly files: ReadonlyMap<string, Buffer>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

// The desktop fills a missing or unreadable color from its built-in theme and drops keys it does not know. A catalog
// theme must read back exactly as written, so the file is compared with what the desktop's own reader makes of it.
function requireReadBackAsWritten(raw: unknown, where: string): void {
    const theme = parseImportedTheme(raw);
    if (theme === undefined || !isRecord(raw)) fail(`${where} is not a saved theme (version 1)`);
    if (isDeepStrictEqual(raw, theme)) return;
    const colors = isRecord(raw.colors) ? raw.colors : {};
    for (const token of COLOR_TOKENS) {
        if (colors[token] !== theme.colors[token]) fail(`${where}: colors.${token} must be #rrggbb or #rrggbbaa in lowercase`);
    }
    const parsed: Record<string, unknown> = { ...theme };
    for (const key of new Set([...Object.keys(raw), ...Object.keys(parsed)])) {
        if (!isDeepStrictEqual(raw[key], parsed[key])) fail(`${where}: "${key}" is missing, malformed or not a key the desktop reads`);
    }
}

// Only the manifest and the files it lists go into a package, so any other file in the folder is an error.
function requireNoStrayFiles(folder: string, listed: ReadonlySet<string>): void {
    for (const name of readdirSync(folder, { recursive: true }) as string[]) {
        const path = name.split("\\").join("/");
        const stat = lstatSync(join(folder, path));
        if (stat.isDirectory()) continue;
        if (!stat.isFile()) fail(`${path} is not a regular file`);
        if (!listed.has(path)) fail(`${path} is not listed in the manifest`);
    }
}

// Reads one extension folder with the desktop's own manifest and theme readers, then applies what the catalog adds:
// themes only, an x.y.z version, and themes that read back as written.
export function readExtensionSource(folder: string, id: string): ExtensionSource {
    const read = readExtension(folder);
    if (!read.ok) fail(read.reason);
    const { manifest, themes } = read;
    if (manifest.id !== id) fail(`the manifest id "${manifest.id}" does not match the folder name`);
    if (!VERSION.test(manifest.version)) fail(`the version "${manifest.version}" must be x.y.z`);
    if (carriesCode(manifest) || manifest.commands.length > 0 || manifest.keybindings.length > 0) {
        fail("a catalog extension adds themes only: it has no main, commands, keybindings or tasks");
    }
    const first = themes[0];
    if (first === undefined) fail("the extension adds no themes");

    const files = new Map<string, Buffer>();
    const manifestBytes = readFileSync(join(folder, DESKTOP_MANIFEST_FILENAME));
    files.set(DESKTOP_MANIFEST_FILENAME, manifestBytes);
    for (const theme of manifest.themes) {
        if (posix.normalize(theme.path) !== theme.path) fail(`theme path "${theme.path}" must be written as themes/<file>.json, with no "." or empty segment`);
        requireReadBackAsWritten(readJson(join(folder, theme.path)), theme.path);
        files.set(theme.path, readFileSync(join(folder, theme.path)));
    }
    requireNoStrayFiles(folder, new Set(files.keys()));

    return {
        id,
        name: first.label,
        version: manifest.version,
        palette: PALETTE_TOKENS.map((token) => first.summary.colors[token]),
        files,
    };
}
