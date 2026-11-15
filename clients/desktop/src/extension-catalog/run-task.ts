import { writeFileSync } from "node:fs";

import { fetchBytes } from "./fetch.ts";
import { CATALOG_TOO_LARGE, parseCatalog } from "./parse-catalog.ts";
import { CatalogRefusal } from "./refusal.ts";
import { CATALOG_UNREACHABLE, DOWNLOAD_FAILED, MAX_CATALOG_BYTES, type CatalogReply, type CatalogTask } from "./task-protocol.ts";

const SIZE_MISMATCH = "The package does not match the size the catalog lists.";

async function list(url: string, engine: string): Promise<CatalogReply> {
    const bytes = await fetchBytes(url, { maxBytes: MAX_CATALOG_BYTES, failed: CATALOG_UNREACHABLE, tooLarge: CATALOG_TOO_LARGE });
    return { ok: true, kind: "list", entries: parseCatalog(bytes, engine) };
}

async function download(url: string, size: number, destination: string): Promise<CatalogReply> {
    const bytes = await fetchBytes(url, { maxBytes: size, failed: DOWNLOAD_FAILED, tooLarge: SIZE_MISMATCH });
    if (bytes.length !== size) throw new CatalogRefusal(SIZE_MISMATCH);
    try {
        writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    } catch {
        throw new CatalogRefusal(DOWNLOAD_FAILED);
    }
    return { ok: true, kind: "download", bytes: bytes.length };
}

// Fetches the catalog or one package. It unpacks nothing and installs nothing: the package is a file for the install task.
export async function runCatalogTask(task: CatalogTask): Promise<CatalogReply> {
    try {
        return task.kind === "list" ? await list(task.url, task.engine) : await download(task.url, task.size, task.destination);
    } catch (error) {
        if (error instanceof CatalogRefusal) return { ok: false, reason: error.message };
        throw error;
    }
}
