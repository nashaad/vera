import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

const MAX_METADATA_BYTES = 256;

export function sessionMetadataPath(sessionPath: string): string {
    return `${sessionPath}.metadata.json`;
}

export async function readSessionArchived(sessionPath: string): Promise<boolean> {
    const path = sessionMetadataPath(sessionPath);
    let file;
    try {
        file = await open(path, "r");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
    try {
        const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < bytes.length) {
            const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_METADATA_BYTES) throw new Error(`Invalid session metadata ${path}`);
        let value: unknown;
        try { value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
        catch { throw new Error(`Invalid session metadata ${path}`); }
        if (typeof value !== "object" || value === null || Array.isArray(value)
            || Object.keys(value).length !== 1 || typeof Reflect.get(value, "archived") !== "boolean") {
            throw new Error(`Invalid session metadata ${path}`);
        }
        return Reflect.get(value, "archived") as boolean;
    } finally {
        await file.close();
    }
}

export async function writeSessionArchived(sessionPath: string, archived: boolean): Promise<void> {
    if (typeof archived !== "boolean") throw new Error("Archived state must be a boolean");
    const path = sessionMetadataPath(sessionPath);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify({ archived }), "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}
