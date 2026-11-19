import { crc32 } from "node:zlib";

import { fail } from "./build-error.ts";

const BLOCK = 512;
const MAX_NAME_BYTES = 100;
const MAX_STORED_BLOCK = 0xffff;
// Magic, deflate, no flags, no mtime, no extra flags, "Unix" as the operating system.
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
    block.write(value.toString(8).padStart(length - 1, "0"), offset, "ascii");
    block[offset + length - 1] = 0;
}

// A ustar header with fixed owner, mode and mtime. `data` is undefined for a folder.
function header(path: string, data: Buffer | undefined): Buffer {
    const block = Buffer.alloc(BLOCK);
    const name = Buffer.from(path, "utf8");
    if (name.length > MAX_NAME_BYTES) fail(`archive path is longer than ${MAX_NAME_BYTES} bytes: ${path}`);
    name.copy(block, 0);
    writeOctal(block, 100, 8, data === undefined ? 0o755 : 0o644);
    writeOctal(block, 108, 8, 0);
    writeOctal(block, 116, 8, 0);
    writeOctal(block, 124, 12, data?.length ?? 0);
    writeOctal(block, 136, 12, 0);
    block.fill(0x20, 148, 156);
    block.write(data === undefined ? "5" : "0", 156, "ascii");
    block.write("ustar\0", 257, "ascii");
    block.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of block) sum += byte;
    writeOctal(block, 148, 7, sum);
    block[155] = 0x20;
    return block;
}

function folderEntries(paths: Iterable<string>): string[] {
    const folders = new Set<string>();
    for (const path of paths) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) folders.add(`${parts.slice(0, index).join("/")}/`);
    }
    return [...folders];
}

export function tarball(files: ReadonlyMap<string, Buffer>): Buffer {
    const entries: { path: string; data: Buffer | undefined }[] = [
        ...folderEntries(files.keys()).map((path) => ({ path, data: undefined })),
        ...[...files].map(([path, data]) => ({ path, data })),
    ];
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const blocks: Buffer[] = [];
    for (const { path, data } of entries) {
        blocks.push(header(path, data));
        if (data !== undefined && data.length > 0) {
            const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
            data.copy(padded);
            blocks.push(padded);
        }
    }
    blocks.push(Buffer.alloc(2 * BLOCK));
    return Buffer.concat(blocks);
}

// Stored deflate blocks, not zlib: zlib puts a per-platform operating system byte in the gzip header and its output can
// differ between builds, so the committed packages would not rebuild to the same bytes on another machine.
export function gzipStored(data: Buffer): Buffer {
    const parts: Buffer[] = [GZIP_HEADER];
    let offset = 0;
    do {
        const length = Math.min(MAX_STORED_BLOCK, data.length - offset);
        const block = Buffer.alloc(5);
        block[0] = offset + length === data.length ? 1 : 0;
        block.writeUInt16LE(length, 1);
        block.writeUInt16LE(~length & 0xffff, 3);
        parts.push(block, data.subarray(offset, offset + length));
        offset += length;
    } while (offset < data.length);
    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(crc32(data), 0);
    trailer.writeUInt32LE(data.length, 4);
    parts.push(trailer);
    return Buffer.concat(parts);
}

// A gzip tar with the files at the archive root, byte for byte the same for the same files.
export function packArchive(files: ReadonlyMap<string, Buffer>): Buffer {
    return gzipStored(tarball(files));
}
