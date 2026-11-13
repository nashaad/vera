import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

import { ThemeRefusal } from "./refusal.ts";
import { readZipDirectory, readZipEntry, type ByteSource, type ZipEntry } from "./zip.ts";

// A theme file, and each file it includes, may be this large.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Where theme files are read from: the disk, or the inside of a .vsix. Paths are in the source's own form.
export interface ThemeSource {
    read(path: string): string;
    // The path of a file named relative to another file in the same source.
    resolve(from: string, relative: string): string;
}

function checkExtension(path: string): void {
    if (!/\.jsonc?$/i.test(path)) throw new ThemeRefusal(`"${posix.basename(path.replaceAll("\\", "/"))}" is not a .json file.`);
}

export const diskSource: ThemeSource = {
    read(path) {
        checkExtension(path);
        let size: number;
        try {
            const stat = statSync(path);
            if (!stat.isFile()) throw new ThemeRefusal(`"${path}" is not a file.`);
            size = stat.size;
        } catch (error) {
            if (error instanceof ThemeRefusal) throw error;
            throw new ThemeRefusal(`Vera could not open "${path}".`);
        }
        if (size > MAX_FILE_BYTES) throw new ThemeRefusal(`"${path}" is larger than 2 MiB.`);
        try {
            return readFileSync(path, "utf8");
        } catch {
            throw new ThemeRefusal(`Vera could not read "${path}".`);
        }
    },
    resolve: (from, relative) => resolve(dirname(from), relative),
};

export function fileByteSource(path: string): { source: ByteSource; close(): void } {
    let fd: number;
    let size: number;
    try {
        fd = openSync(path, "r");
        size = statSync(path).size;
    } catch {
        throw new ThemeRefusal(`Vera could not open "${path}".`);
    }
    const source: ByteSource = {
        size,
        read(offset, length) {
            const buffer = Buffer.alloc(length);
            const got = readSync(fd, buffer, 0, length, offset);
            return got === length ? buffer : buffer.subarray(0, got);
        },
    };
    return { source, close: () => closeSync(fd) };
}

// Reads files inside an archive. Paths are archive paths with forward slashes, and none may leave the archive.
export function zipSource(bytes: ByteSource): ThemeSource & { has(path: string): boolean } {
    const entries = readZipDirectory(bytes, (name) => /\.jsonc?$/i.test(name));
    const entryOf = (path: string): ZipEntry => {
        const entry = entries.get(path);
        if (entry === undefined) throw new ThemeRefusal(`The .vsix has no file "${path}".`);
        return entry;
    };
    return {
        has: (path) => entries.has(path),
        read(path) {
            return readZipEntry(bytes, entryOf(path), MAX_FILE_BYTES).toString("utf8");
        },
        resolve(from, relative) {
            const joined = posix.normalize(posix.join(posix.dirname(from), relative.replaceAll("\\", "/")));
            if (joined.startsWith("../") || joined === ".." || posix.isAbsolute(joined)) {
                throw new ThemeRefusal(`"${relative}" points outside the .vsix.`);
            }
            return joined;
        },
    };
}
