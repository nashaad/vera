import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
    MAX_MAIN_BYTES,
    type ExtensionMainResult,
} from "../../ui/src/protocol/desktop-extensions.ts";

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

// Reads the declared main file from the authoritative installed entry's folder.
export async function readExtensionMain(folder: string, main: unknown): Promise<ExtensionMainResult> {
    if (typeof main !== "string") return { ok: false, reason: "The main file must be a relative path." };
    return readContained(folder, main, MAX_MAIN_BYTES);
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
