import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The host copies an attached image into the session, so a pasted file is only needed until it answers.
export const PASTED_IMAGE_MAX_BYTES = 20 * 1_024 * 1_024;
export const PASTED_IMAGE_KEEP_MS = 60 * 60 * 1_000;

const EXTENSIONS: Readonly<Record<string, string>> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
};

export function pastedImageDirectory(home: string): string {
    return join(home, "machine", "desktop", "pasted-images");
}

// Writes clipboard image bytes to a file the host can read; undefined for other types or oversized data.
export async function savePastedImage(
    directory: string,
    bytes: Uint8Array,
    mediaType: string,
    now: number = Date.now(),
): Promise<string | undefined> {
    const extension = EXTENSIONS[mediaType];
    if (extension === undefined || bytes.byteLength === 0 || bytes.byteLength > PASTED_IMAGE_MAX_BYTES) return undefined;
    await mkdir(directory, { recursive: true });
    await sweepPastedImages(directory, now);
    const path = join(directory, `${randomUUID()}${extension}`);
    await writeFile(path, bytes);
    return path;
}

export async function sweepPastedImages(directory: string, now: number): Promise<void> {
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
        const path = join(directory, name);
        const info = await stat(path).catch(() => undefined);
        if (info !== undefined && info.isFile() && now - info.mtimeMs > PASTED_IMAGE_KEEP_MS) {
            await rm(path, { force: true }).catch(() => undefined);
        }
    }
}
