import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";

import {
    MAX_PACKAGE_BYTES,
    MAX_PACKAGE_ENTRIES,
    MAX_PACKAGE_FILE_BYTES,
    MAX_PACKAGE_PATH_CHARS,
    MAX_PACKAGE_TOTAL_BYTES,
} from "../extensions/limits.ts";
import { ExtensionRefusal } from "./refusal.ts";
import { readTar, type TarEntry } from "./tar.ts";

const NOT_A_PACKAGE = "The package is not a gzip tar file.";
// Tar adds a header and padding to each entry, and two empty blocks at the end.
const TAR_OVERHEAD = MAX_PACKAGE_ENTRIES * 1024 + 1024;

// The package's bytes, read once so the checksum and the unpacked files are the same bytes.
export function readPackage(path: string): Buffer {
    let size: number;
    try {
        const stat = statSync(path);
        if (!stat.isFile()) throw new ExtensionRefusal("The package is not a file.");
        size = stat.size;
    } catch (error) {
        if (error instanceof ExtensionRefusal) throw error;
        throw new ExtensionRefusal("Vera could not read the package.");
    }
    if (size > MAX_PACKAGE_BYTES) throw new ExtensionRefusal(`The package is larger than ${MAX_PACKAGE_BYTES / 1024 / 1024} MiB.`);
    try {
        return readFileSync(path);
    } catch {
        throw new ExtensionRefusal("Vera could not read the package.");
    }
}

export function checkSha256(bytes: Buffer, expected: string): void {
    if (createHash("sha256").update(bytes).digest("hex") !== expected.trim().toLowerCase()) {
        throw new ExtensionRefusal("The package does not match its expected checksum.");
    }
}

export function packageEntries(bytes: Buffer): TarEntry[] {
    let tar: Buffer;
    try {
        tar = gunzipSync(bytes, { maxOutputLength: MAX_PACKAGE_TOTAL_BYTES + TAR_OVERHEAD });
    } catch (error) {
        const tooLarge = (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
        throw new ExtensionRefusal(tooLarge ? `The package unpacks to more than ${MAX_PACKAGE_TOTAL_BYTES / 1024 / 1024} MiB.` : NOT_A_PACKAGE);
    }
    return readTar(tar, {
        entries: MAX_PACKAGE_ENTRIES,
        fileBytes: MAX_PACKAGE_FILE_BYTES,
        totalBytes: MAX_PACKAGE_TOTAL_BYTES,
        pathChars: MAX_PACKAGE_PATH_CHARS,
    });
}

// Writes regular files and folders into an empty staging folder. Never overwrites, never follows a link.
export function unpackEntries(entries: readonly TarEntry[], staging: string): void {
    try {
        for (const entry of entries) {
            const target = join(staging, ...entry.path.split("/"));
            const inside = relative(staging, target);
            if (inside.startsWith("..") || isAbsolute(inside)) throw new ExtensionRefusal(`The package holds a path that leaves its folder or is not plain text: "${entry.path}".`);
            if (entry.kind === "directory") {
                mkdirSync(target, { recursive: true, mode: 0o700 });
            } else {
                mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
                writeFileSync(target, entry.data, { flag: "wx", mode: 0o600 });
            }
        }
    } catch (error) {
        if (error instanceof ExtensionRefusal) throw error;
        throw new ExtensionRefusal("Vera could not unpack the package.");
    }
}
