import { ExtensionRefusal } from "./refusal.ts";

const BLOCK = 512;
const NAME = { start: 0, end: 100 };
const SIZE = { start: 124, end: 136 };
const CHECKSUM = { start: 148, end: 156 };
const TYPE = 156;
const MAGIC = { start: 257, end: 262 };
const PREFIX = { start: 345, end: 500 };
const REGULAR_FILE = [0x30, 0];
const DIRECTORY = 0x35;

export interface TarLimits {
    readonly entries: number;
    readonly fileBytes: number;
    readonly totalBytes: number;
    readonly pathChars: number;
}

export interface TarEntry {
    // Slash-separated, relative, with no "." or ".." segment.
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly data: Buffer;
}

function text(block: Buffer, field: { start: number; end: number }): string {
    const bytes = block.subarray(field.start, field.end);
    const end = bytes.indexOf(0);
    return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function octal(block: Buffer, field: { start: number; end: number }): number | undefined {
    const digits = text(block, field).trim();
    return /^[0-7]+$/.test(digits) ? Number.parseInt(digits, 8) : undefined;
}

function checksumOf(block: Buffer): number {
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) {
        sum += index >= CHECKSUM.start && index < CHECKSUM.end ? 0x20 : (block[index] ?? 0);
    }
    return sum;
}

// A name as the person should see it: short, and with control characters shown as "?".
function shown(path: string): string {
    return `"${path.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 80)}"`;
}

// The path as slash-separated segments, or undefined when it is absolute, leaves the folder, or is not plain text.
function cleanPath(raw: string, limit: number): string | undefined {
    if (raw.length === 0 || raw.length > limit || /[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
        return undefined;
    }
    const segments = raw.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    return segments.includes("..") ? undefined : segments.join("/");
}

// Reads the entries of an uncompressed tar archive that holds only regular files and folders. Throws a refusal for
// anything else: links, devices, extended headers, absolute paths, "..", repeated names, and anything over a cap.
export function readTar(bytes: Buffer, limits: TarLimits): TarEntry[] {
    const entries: TarEntry[] = [];
    const seen = new Set<string>();
    let total = 0;
    let offset = 0;
    while (offset + BLOCK <= bytes.length) {
        const header = bytes.subarray(offset, offset + BLOCK);
        if (header.every((byte) => byte === 0)) return entries;
        const checksum = octal(header, CHECKSUM);
        if (checksum === undefined || checksum !== checksumOf(header)) throw new ExtensionRefusal("The package is not a gzip tar file.");
        const type = header[TYPE] ?? 0;
        const isFile = REGULAR_FILE.includes(type);
        const name = text(header, NAME);
        const prefix = text(header, MAGIC) === "ustar" ? text(header, PREFIX) : "";
        const raw = prefix.length > 0 ? `${prefix}/${name}` : name;
        if (!isFile && type !== DIRECTORY) {
            throw new ExtensionRefusal(`The package holds ${shown(raw)}, which is not a plain file or folder.`);
        }
        const path = cleanPath(raw, limits.pathChars);
        if (path === undefined) throw new ExtensionRefusal(`The package holds a path that leaves its folder or is not plain text: ${shown(raw)}.`);
        const size = (header[SIZE.start] ?? 0) & 0x80 ? undefined : octal(header, SIZE);
        if (size === undefined) throw new ExtensionRefusal("The package is not a gzip tar file.");
        if (!isFile && size !== 0) throw new ExtensionRefusal("The package is not a gzip tar file.");
        if (size > limits.fileBytes) throw new ExtensionRefusal(`${shown(path)} is larger than ${limits.fileBytes / 1024 / 1024} MiB.`);
        total += size;
        if (total > limits.totalBytes) throw new ExtensionRefusal(`The package unpacks to more than ${limits.totalBytes / 1024 / 1024} MiB.`);
        const start = offset + BLOCK;
        if (start + size > bytes.length) throw new ExtensionRefusal("The package is not a gzip tar file.");
        offset = start + Math.ceil(size / BLOCK) * BLOCK;
        if (path.length === 0) {
            if (isFile) throw new ExtensionRefusal(`The package holds a path that leaves its folder or is not plain text: ${shown(raw)}.`);
            continue;
        }
        const folded = path.toLowerCase();
        if (seen.has(folded)) throw new ExtensionRefusal(`The package lists ${shown(path)} twice.`);
        seen.add(folded);
        if (entries.length >= limits.entries) throw new ExtensionRefusal(`The package holds more than ${limits.entries} entries.`);
        entries.push({ path, kind: isFile ? "file" : "directory", data: bytes.subarray(start, start + size) });
    }
    return entries;
}
