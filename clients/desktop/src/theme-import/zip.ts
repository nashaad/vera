import { inflateRawSync } from "node:zlib";

import { ThemeRefusal } from "./refusal.ts";

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 65_535;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
// Only JSON files are kept from the directory, and no more than this many.
const MAX_KEPT_ENTRIES = 5_000;

// Reads of an archive go through this, so a large file is read by offset and never held whole.
export interface ByteSource {
    readonly size: number;
    read(offset: number, length: number): Buffer;
}

export interface ZipEntry {
    readonly name: string;
    readonly method: number;
    readonly compressedSize: number;
    readonly size: number;
    readonly headerOffset: number;
}

export function bufferSource(buffer: Buffer): ByteSource {
    return { size: buffer.length, read: (offset, length) => buffer.subarray(offset, offset + length) };
}

function notAnArchive(): ThemeRefusal {
    return new ThemeRefusal("The file is not a readable .vsix archive.");
}

function endRecord(source: ByteSource): Buffer {
    const tailLength = Math.min(source.size, END_RECORD_BYTES + MAX_COMMENT_BYTES);
    const tail = source.read(source.size - tailLength, tailLength);
    for (let at = tail.length - END_RECORD_BYTES; at >= 0; at -= 1) {
        if (tail.readUInt32LE(at) === END_SIGNATURE) return tail.subarray(at, at + END_RECORD_BYTES);
    }
    throw notAnArchive();
}

// The entries whose names `keep` accepts, read from the archive's central directory.
export function readZipDirectory(source: ByteSource, keep: (name: string) => boolean): Map<string, ZipEntry> {
    const end = endRecord(source);
    const count = end.readUInt16LE(10);
    const size = end.readUInt32LE(12);
    const offset = end.readUInt32LE(16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
        throw new ThemeRefusal("The .vsix is a ZIP64 archive, which Vera does not read.");
    }
    if (size > MAX_DIRECTORY_BYTES || count > MAX_ENTRIES || offset + size > source.size) throw notAnArchive();
    const directory = source.read(offset, size);
    const entries = new Map<string, ZipEntry>();
    let at = 0;
    for (let index = 0; index < count; index += 1) {
        if (at + CENTRAL_HEADER_BYTES > directory.length || directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw notAnArchive();
        const flags = directory.readUInt16LE(at + 8);
        const nameLength = directory.readUInt16LE(at + 28);
        const extraLength = directory.readUInt16LE(at + 30);
        const commentLength = directory.readUInt16LE(at + 32);
        const next = at + CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
        if (next > directory.length) throw notAnArchive();
        const name = directory.toString("utf8", at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength);
        if (keep(name) && (flags & 1) === 0) {
            if (entries.size >= MAX_KEPT_ENTRIES) throw new ThemeRefusal("The .vsix holds too many JSON files to read.");
            entries.set(name, {
                name,
                method: directory.readUInt16LE(at + 10),
                compressedSize: directory.readUInt32LE(at + 20),
                size: directory.readUInt32LE(at + 24),
                headerOffset: directory.readUInt32LE(at + 42),
            });
        }
        at = next;
    }
    return entries;
}

// The entry's bytes, stopping with a refusal when they would pass `maxBytes`.
export function readZipEntry(source: ByteSource, entry: ZipEntry, maxBytes: number): Buffer {
    if (entry.size > maxBytes || entry.compressedSize > maxBytes) {
        throw new ThemeRefusal(`"${entry.name}" is larger than ${Math.floor(maxBytes / 1024 / 1024)} MiB.`);
    }
    if (entry.headerOffset + LOCAL_HEADER_BYTES > source.size) throw notAnArchive();
    const header = source.read(entry.headerOffset, LOCAL_HEADER_BYTES);
    if (header.length < LOCAL_HEADER_BYTES || header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw notAnArchive();
    const dataStart = entry.headerOffset + LOCAL_HEADER_BYTES + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (dataStart + entry.compressedSize > source.size) throw notAnArchive();
    const data = source.read(dataStart, entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new ThemeRefusal(`"${entry.name}" uses a compression method Vera does not read.`);
    try {
        const inflated = inflateRawSync(data, { maxOutputLength: maxBytes });
        if (inflated.length !== entry.size) throw notAnArchive();
        return inflated;
    } catch (error) {
        if (error instanceof ThemeRefusal) throw error;
        throw new ThemeRefusal(`"${entry.name}" could not be unpacked from the .vsix.`);
    }
}
