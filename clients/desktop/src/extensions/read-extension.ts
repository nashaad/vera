import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { DESKTOP_MANIFEST_FILENAME, parseDesktopManifest, type DesktopManifest } from "../../../ui/src/extensions/manifest.ts";
import { parseImportedTheme, summaryOf, type ImportedThemeSummary } from "../../../ui/src/theme/imported.ts";
import { isThemeSlug } from "../../../ui/src/theme/tokens.ts";
import { MAX_THEME_BYTES } from "../theme-store.ts";
import { MAX_MANIFEST_BYTES } from "./limits.ts";

export const MAX_PAGE_SCRIPT_BYTES = 256 * 1024;

export interface ExtensionTheme {
    readonly label: string;
    // The saved theme without its token rules.
    readonly summary: ImportedThemeSummary;
}

export type ManifestRead =
    | { readonly ok: true; readonly manifest: DesktopManifest }
    | { readonly ok: false; readonly reason: string };

export type ExtensionRead =
    | { readonly ok: true; readonly manifest: DesktopManifest; readonly themes: readonly ExtensionTheme[] }
    | { readonly ok: false; readonly reason: string };

// Reads a regular file of at most `limit` bytes. Anything else, including a link, reads as undefined.
export function readRegularFile(path: string, limit: number): string | undefined {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size > limit) return undefined;
        const buffer = Buffer.alloc(stat.size);
        let read = 0;
        while (read < stat.size) {
            const count = readSync(descriptor, buffer, read, stat.size - read, read);
            if (count === 0) break;
            read += count;
        }
        return buffer.subarray(0, read).toString("utf8");
    } catch {
        return undefined;
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

function isRegularFile(path: string, limit = Infinity): boolean {
    try {
        const stat = lstatSync(path);
        return stat.isFile() && stat.size <= limit;
    } catch {
        return false;
    }
}

// The path a manifest names, kept inside the extension folder.
function insideFolder(folder: string, path: string): string | undefined {
    const target = resolve(folder, path);
    const inside = relative(resolve(folder), target);
    return inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside) ? target : undefined;
}

// The file a task's `main` names, or undefined when it is not a regular file inside the extension folder.
export function taskWorkerFile(folder: string, main: string): string | undefined {
    const file = insideFolder(folder, main);
    if (file === undefined) return undefined;
    try {
        let part = resolve(folder);
        for (const name of main.replace(/\\/g, "/").split("/")) {
            part = join(part, name);
            if (lstatSync(part).isSymbolicLink()) return undefined;
        }
        return isRegularFile(file) ? file : undefined;
    } catch {
        return undefined;
    }
}

export function carriesCode(manifest: DesktopManifest): boolean {
    return manifest.main !== undefined || manifest.tasks.length > 0 || manifest.commands.some((command) => command.page !== undefined);
}

export function hasUnavailableContributions(manifest: DesktopManifest): boolean {
    return manifest.tasks.length > 0
        || manifest.commands.some((command) => command.task !== undefined || command.page !== undefined)
        || manifest.menus.appearance.length > 0
        || manifest.menus.theme.length > 0
        || manifest.menus.browser.length > 0;
}

export function readManifest(folder: string): ManifestRead {
    const text = readRegularFile(join(folder, DESKTOP_MANIFEST_FILENAME), MAX_MANIFEST_BYTES);
    if (text === undefined) return { ok: false, reason: `The extension has no ${DESKTOP_MANIFEST_FILENAME}.` };
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return { ok: false, reason: `${DESKTOP_MANIFEST_FILENAME} is not valid JSON.` };
    }
    const parsed = parseDesktopManifest(value);
    return parsed.ok ? parsed : { ok: false, reason: `${DESKTOP_MANIFEST_FILENAME}: ${parsed.reason}` };
}

// The manifest and every contributed theme file. An extension is readable only when all of them are.
export function readExtension(folder: string): ExtensionRead {
    const read = readManifest(folder);
    if (!read.ok) return read;
    const { manifest } = read;
    if (manifest.main !== undefined) {
        const main = insideFolder(folder, manifest.main);
        if (main === undefined || !isRegularFile(main)) {
            return { ok: false, reason: `The module "${manifest.main}" that "main" names is not in the extension.` };
        }
    }
    for (const task of manifest.tasks) {
        if (taskWorkerFile(folder, task.main) === undefined) {
            return { ok: false, reason: `The file "${task.main}" that task "${task.id}" names is not in the extension.` };
        }
    }
    for (const command of manifest.commands) {
        const file = command.page === undefined ? undefined : taskWorkerFile(folder, command.page);
        if (command.page !== undefined && (file === undefined || !isRegularFile(file, MAX_PAGE_SCRIPT_BYTES))) {
            return { ok: false, reason: `The page script "${command.page}" is not in the extension.` };
        }
    }
    const themes: ExtensionTheme[] = [];
    const slugs = new Set<string>();
    for (const entry of manifest.themes) {
        const path = insideFolder(folder, entry.path);
        const text = path === undefined ? undefined : readRegularFile(path, MAX_THEME_BYTES);
        if (text === undefined) {
            return { ok: false, reason: `Theme "${entry.label}": "${entry.path}" is missing or larger than ${MAX_THEME_BYTES / 1024 / 1024} MiB.` };
        }
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            return { ok: false, reason: `Theme "${entry.label}": "${entry.path}" is not valid JSON.` };
        }
        const theme = parseImportedTheme(value);
        if (theme === undefined || !isThemeSlug(theme.slug)) {
            return { ok: false, reason: `Theme "${entry.label}": "${entry.path}" is not a saved theme (version 1).` };
        }
        if (slugs.has(theme.slug)) return { ok: false, reason: `Theme "${entry.label}": its slug "${theme.slug}" is used by another theme in the extension.` };
        slugs.add(theme.slug);
        themes.push({ label: entry.label, summary: summaryOf(theme) });
    }
    return { ok: true, manifest, themes };
}
