import {
    closeSync,
    constants,
    fstatSync,
    openSync,
    readSync,
} from "node:fs";

const READ_CHUNK_BYTES = 64 * 1_024;
export const DEFAULT_REGULAR_FILE_LIMIT_BYTES = 64 * 1_024 * 1_024;

export function readRegularFileTextSync(
    path: string,
    maxBytes = DEFAULT_REGULAR_FILE_LIMIT_BYTES,
): string {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error("Regular file read limit must be a positive integer");
    }

    const descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
        const file = fstatSync(descriptor);
        if (!file.isFile()) {
            throw new Error(`Not a regular file: ${path}`);
        }
        if (file.size > maxBytes) {
            throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
        }

        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
            const remaining = maxBytes + 1 - total;
            const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
            const bytesRead = readSync(
                descriptor,
                chunk,
                0,
                chunk.length,
                null,
            );
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > maxBytes) {
                throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
            }
            chunks.push(chunk.subarray(0, bytesRead));
        }
        return Buffer.concat(chunks, total).toString("utf8");
    } finally {
        closeSync(descriptor);
    }
}
