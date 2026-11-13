import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
    MAX_LISTED_EXTENSIONS,
    MAX_MAIN_BYTES,
    MAX_MANIFEST_BYTES,
    type ExtensionFolder,
    type ExtensionListResult,
    type ExtensionMainResult,
} from "../../ui/src/protocol/desktop-extensions.ts";

const MANIFEST_FILE = "vera.desktop.json";
const MAX_MAIN_PATH_CHARS = 260;
const NOT_FOUND = "The file does not exist.";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function extensionsDirectory(home: string): string {
    return join(home, "machine", "desktop", "extensions");
}

// A folder name or extension id that cannot step out of the extensions directory.
export function isFolderName(value: unknown): value is string {
    return typeof value === "string" && SEGMENT.test(value) && !value.includes("..");
}

// Lists each extension folder with its raw manifest. Nothing is parsed or run here.
export async function listExtensionFolders(directory: string): Promise<ExtensionListResult> {
    let names: string[];
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        names = entries.filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
            .map((entry) => entry.name)
            .sort();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, folders: [], truncated: false };
        return { ok: false, reason: "The extensions folder could not be read." };
    }
    const folders: ExtensionFolder[] = [];
    for (const name of names.slice(0, MAX_LISTED_EXTENSIONS)) {
        if (!isFolderName(name)) {
            folders.push({ directory: name, problem: "The folder name is not a valid extension id." });
            continue;
        }
        const read = await readContained(join(directory, name), MANIFEST_FILE, MAX_MANIFEST_BYTES);
        const problem = read.ok ? undefined : read.reason === NOT_FOUND ? `No ${MANIFEST_FILE} in this folder.` : read.reason;
        folders.push(read.ok ? { directory: name, text: read.source } : { directory: name, problem: problem ?? "" });
    }
    return { ok: true, folders, truncated: names.length > MAX_LISTED_EXTENSIONS };
}

// Reads an extension's main file, only from inside its own folder, even through symlinks.
export async function readExtensionMain(directory: string, extensionId: unknown, main: unknown): Promise<ExtensionMainResult> {
    if (!isFolderName(extensionId)) return { ok: false, reason: "That is not an extension id." };
    if (typeof main !== "string") return { ok: false, reason: "The main file must be a relative path." };
    return readContained(join(directory, extensionId), main, MAX_MAIN_BYTES);
}

async function readContained(folder: string, relative: string, maxBytes: number): Promise<ExtensionMainResult> {
    if (
        relative.length === 0
        || relative.length > MAX_MAIN_PATH_CHARS
        || relative.includes("\0")
        || isAbsolute(relative)
        || relative.split(/[\\/]/).includes("..")
    ) {
        return { ok: false, reason: "The file path must stay inside the extension folder." };
    }
    try {
        const root = await realpath(folder);
        const target = await realpath(resolve(root, relative));
        if (!target.startsWith(root + sep)) return { ok: false, reason: "The file path must stay inside the extension folder." };
        const handle = await open(target, "r");
        try {
            const info = await handle.stat();
            if (!info.isFile()) return { ok: false, reason: "The path is not a file." };
            if (info.size > maxBytes) return { ok: false, reason: `The file is larger than ${Math.floor(maxBytes / 1024)} KiB.` };
            // A file that grew after the stat still cannot pass the cap.
            const buffer = Buffer.alloc(maxBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
            if (bytesRead > maxBytes) return { ok: false, reason: `The file is larger than ${Math.floor(maxBytes / 1024)} KiB.` };
            return { ok: true, source: buffer.subarray(0, bytesRead).toString("utf8") };
        } finally {
            await handle.close();
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === "ENOENT" ? NOT_FOUND : "The file could not be read." };
    }
}
