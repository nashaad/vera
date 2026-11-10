import { open, type FileHandle } from "node:fs/promises";

export const SESSION_SCAN_CHUNK_BYTES = 1024 * 1024;

export interface SessionLine {
    readonly offset: number;
    readonly length: number;
    readonly bytes: Buffer;
    readonly text: string;
}

export async function scanSessionLines(
    path: string,
    visit: (line: SessionLine) => void,
    includeTail = false,
    source?: FileHandle,
    maxLines?: number,
): Promise<{ readonly completeBytes: number; readonly totalBytes: number }> {
    return scanSessionBytes(path, (offset, length, bytes) => {
        visit({ offset, length, bytes, get text() { return bytes.toString("utf8"); } });
    }, includeTail, source, maxLines);
}

export async function scanSessionBytes(
    path: string,
    visit: (offset: number, length: number, bytes: Buffer) => void,
    includeTail = false,
    source?: FileHandle,
    maxLines?: number,
): Promise<{ readonly completeBytes: number; readonly totalBytes: number }> {
    return scanSessionRanges(path, (offset, length, bytes, start, end) => {
        visit(offset, length, start === 0 && end === bytes.length ? bytes : bytes.subarray(start, end));
    }, includeTail, source, maxLines);
}

export async function scanSessionRanges(
    path: string,
    visit: (offset: number, length: number, bytes: Buffer, start: number, end: number) => void,
    includeTail = false,
    source?: FileHandle,
    maxLines?: number,
): Promise<{ readonly completeBytes: number; readonly totalBytes: number }> {
    const file = source ?? await open(path, "r");
    const chunk = Buffer.allocUnsafe(SESSION_SCAN_CHUNK_BYTES);
    let offset = 0;
    let position = 0;
    let lines = 0;
    try {
        while (true) {
            const chunkStart = position;
            const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            let start = 0;
            while (start < bytesRead) {
                const end = chunk.indexOf(10, start);
                if (end < 0 || end >= bytesRead) break;
                const length = chunkStart + end - offset + 1;
                if (offset < chunkStart) {
                    const bytes = await readBytes(file, offset, length - 1);
                    visit(offset, length, bytes, 0, bytes.length);
                } else {
                    visit(offset, length, chunk, start, end);
                }
                offset += length;
                lines += 1;
                if (maxLines !== undefined && lines >= maxLines) {
                    return { completeBytes: offset, totalBytes: offset };
                }
                start = end + 1;
            }
        }
        if (includeTail && position > offset) {
            const bytes = await readBytes(file, offset, position - offset);
            visit(offset, bytes.length, bytes, 0, bytes.length);
        }
        return { completeBytes: offset, totalBytes: position };
    } finally {
        if (source === undefined) await file.close();
    }
}

async function readBytes(file: FileHandle, offset: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
        const result = await file.read(buffer, read, length - read, offset + read);
        if (result.bytesRead === 0) throw new Error("Unexpected end of session file");
        read += result.bytesRead;
    }
    return buffer;
}

export async function readSessionLine(
    path: string,
    offset: number,
    length: number,
    source?: FileHandle,
): Promise<string> {
    const file = source ?? await open(path, "r");
    try {
        const buffer = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
            const result = await file.read(buffer, read, length - read, offset + read);
            if (result.bytesRead === 0) throw new Error(`Unexpected end of session file ${path}`);
            read += result.bytesRead;
        }
        return buffer.subarray(0, length - 1).toString("utf8");
    } finally {
        if (source === undefined) await file.close();
    }
}
