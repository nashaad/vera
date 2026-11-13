import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { MAX_FILE_PREVIEW_BYTES, type FilePreview } from "../../ui/src/protocol/bridge.ts";

const NUL = 0x00;
const NEWLINE = 0x0a;
const UNREADABLE = "This file could not be read.";

// O_NONBLOCK keeps a named pipe from holding the open until something writes to it.
export async function readFilePreview(path: string): Promise<FilePreview> {
    let handle: FileHandle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
        return { ok: false, reason: missing(error) ? "This file is gone." : UNREADABLE };
    }
    try {
        const info = await handle.stat();
        if (info.isDirectory()) return { ok: false, reason: "This is a folder." };
        if (!info.isFile()) return { ok: false, reason: "This is not a regular file." };
        const wanted = Math.min(info.size, MAX_FILE_PREVIEW_BYTES);
        const buffer = Buffer.alloc(wanted);
        let filled = 0;
        while (filled < wanted) {
            const { bytesRead } = await handle.read(buffer, filled, wanted - filled, filled);
            if (bytesRead === 0) break;
            filled += bytesRead;
        }
        let bytes = buffer.subarray(0, filled);
        if (bytes.includes(NUL)) return { ok: false, reason: "This file is not text." };
        const cut = info.size > filled;
        if (cut) {
            const lastNewline = bytes.lastIndexOf(NEWLINE);
            if (lastNewline >= 0) bytes = bytes.subarray(0, lastNewline + 1);
        }
        // Streaming leaves out a character the cap split in half instead of showing a replacement mark.
        const text = new TextDecoder().decode(bytes, { stream: cut });
        return { ok: true, text, size: info.size, cut };
    } catch {
        return { ok: false, reason: UNREADABLE };
    } finally {
        await handle.close().catch(() => undefined);
    }
}

function missing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
