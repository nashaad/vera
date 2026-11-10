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
): Promise<{ readonly completeBytes: number; readonly totalBytes: number }> {
    const file = source ?? await open(path, "r");
    const chunk = Buffer.allocUnsafe(SESSION_SCAN_CHUNK_BYTES);
    let offset = 0;
    let position = 0;
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
                const bytes = offset < chunkStart
                    ? await readBytes(file, offset, length - 1)
                    : chunk.subarray(start, end);
                visit({ offset, length, bytes, get text() { return bytes.toString("utf8"); } });
                offset += length;
                start = end + 1;
            }
        }
        if (includeTail && position > offset) {
            const bytes = await readBytes(file, offset, position - offset);
            visit({ offset, length: bytes.length, bytes, get text() { return bytes.toString("utf8"); } });
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

export async function readSessionLine(path: string, offset: number, length: number): Promise<string> {
    const file = await open(path, "r");
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
        await file.close();
    }
}
