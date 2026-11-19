import { randomUUID } from "node:crypto";
import { open, rename, rm, stat, type FileHandle } from "node:fs/promises";

import { parseHeaderRecord } from "./session-store.ts";

const HEADER_LIMIT_BYTES = 64 * 1_024;
const COPY_CHUNK_BYTES = 256 * 1_024;

export interface RewriteSessionCwdHooks {
    readonly beforeReplace?: () => Promise<void>;
}

/**
 * Replaces the cwd on line 1 and keeps every later byte as written. Only for a session
 * that is closed and reserved: the copy cannot see appends made while it runs.
 */
export async function rewriteSessionCwd(
    path: string,
    cwd: string,
    hooks: RewriteSessionCwdHooks = {},
): Promise<void> {
    if (cwd.length === 0 || cwd.includes("\0")) throw new Error("Cannot record an empty or invalid workspace");
    const temporaryPath = `${path}.moving`;
    const source = await open(path, "r");
    try {
        const { mode, size } = await source.stat();
        const { line, bodyStart } = await readHeaderLine(path, source);
        const record = parseHeaderLine(path, line);
        const header = Buffer.from(`${JSON.stringify({ ...record, cwd })}\n`, "utf8");

        // A leftover from a crashed move is ours to replace; the reservation keeps a second move out.
        await rm(temporaryPath, { force: true });
        try {
            const copied = await writeCopy(source, temporaryPath, header, bodyStart, mode & 0o7777);
            if (copied !== size - bodyStart || (await stat(path)).size !== size) {
                throw new Error(`Session file ${path} changed while its workspace was being rewritten`);
            }
            await hooks.beforeReplace?.();
            await rename(temporaryPath, path);
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }
    } finally {
        await source.close();
    }
}

function parseHeaderLine(path: string, line: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch (error) {
        throw new Error(`Invalid session file ${path}: line 1 is not valid JSON`, { cause: error });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Invalid session file ${path}: line 1 is not a valid session header`);
    }
    parseHeaderRecord(path, value as Record<string, unknown>);
    return value as Record<string, unknown>;
}

async function readHeaderLine(path: string, file: FileHandle): Promise<{ line: string; bodyStart: number }> {
    const buffer = Buffer.allocUnsafe(HEADER_LIMIT_BYTES);
    let length = 0;
    while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        const newlineAt = buffer.subarray(length, length + bytesRead).indexOf(0x0a);
        length += bytesRead;
        if (newlineAt !== -1) {
            const end = length - bytesRead + newlineAt;
            return { line: buffer.toString("utf8", 0, end), bodyStart: end + 1 };
        }
    }
    throw new Error(`Invalid session file ${path}: ${length < buffer.length ? "has no complete header line" : "session header exceeds 64 KiB"}`);
}

async function writeCopy(
    source: FileHandle,
    temporaryPath: string,
    header: Buffer,
    bodyStart: number,
    mode: number,
): Promise<number> {
    const output = await open(temporaryPath, "wx", mode);
    try {
        await output.chmod(mode);
        await writeAll(output, header, header.length);
        const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        let position = bodyStart;
        for (;;) {
            const { bytesRead } = await source.read(chunk, 0, chunk.length, position);
            if (bytesRead === 0) break;
            await writeAll(output, chunk, bytesRead);
            position += bytesRead;
        }
        await output.sync();
        return position - bodyStart;
    } finally {
        await output.close();
    }
}

async function writeAll(output: FileHandle, buffer: Buffer, length: number): Promise<void> {
    let written = 0;
    while (written < length) {
        const result = await output.write(buffer, written, length - written);
        written += result.bytesWritten;
    }
}
