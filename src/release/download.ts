import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { open } from "node:fs/promises";

export const UPDATE_FETCH_TIMEOUT_MS = 30_000;

export interface DownloadProgress {
    readonly url: string;
    readonly bytes: number;
    readonly total: number | undefined;
}

export interface DownloadOptions {
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
    readonly repo?: string;
    readonly downloadBase?: string;
    // Aborting ends the request in flight and rejects with the signal's reason.
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: DownloadProgress) => void;
}

// A missing file is told apart from a failed download: an absent release asset is an answer, not an error.
export class DownloadStatusError extends Error {
    constructor(readonly url: string, readonly status: number) {
        super(`Could not download ${url}: HTTP ${status}`);
        this.name = "DownloadStatusError";
    }
}

// Where one release's assets live: GitHub by default, VERA_RELEASES_DOWNLOAD_BASE for a mirror.
export function releaseAssetBase(options: DownloadOptions, tag: string): string {
    const repo = options.repo ?? process.env.VERA_REPO ?? "nashaad/vera";
    const configuredBase = options.downloadBase ?? process.env.VERA_RELEASES_DOWNLOAD_BASE;
    const downloadBase = configuredBase !== undefined && configuredBase.length > 0
        ? configuredBase.replace(/\/+$/, "")
        : `https://github.com/${repo}/releases/download`;
    return `${downloadBase}/${tag}`;
}

export type ReadChunks = (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>;

export async function fetchWithTimeout<T>(
    url: string,
    options: DownloadOptions,
    headers: Record<string, string>,
    consume: (response: Response, readBody: () => Promise<string>, readChunks: ReadChunks) => Promise<T>,
): Promise<T> {
    const fetchImpl = options.fetch ?? fetch;
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? UPDATE_FETCH_TIMEOUT_MS;
    const stalled = new Error(`Download of ${url} stalled for ${timeoutMs / 1000} s.`);
    const outer = options.signal;
    outer?.throwIfAborted();
    const onOuterAbort = (): void => controller.abort(outer?.reason);
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    async function waitForProgress<R>(operation: Promise<R>): Promise<R> {
        if (outer?.aborted === true) {
            void operation.catch(() => undefined);
            throw outer.reason;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        reject(stalled);
                        controller.abort(stalled);
                    }, timeoutMs);
                    if (outer !== undefined) {
                        onAbort = () => reject(outer.reason);
                        outer.addEventListener("abort", onAbort, { once: true });
                    }
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (onAbort !== undefined) outer?.removeEventListener("abort", onAbort);
        }
    }
    let response: Response;
    try {
        response = await waitForProgress(fetchImpl(url, {
            signal: controller.signal,
            headers,
        }));
    } catch (error) {
        outer?.removeEventListener("abort", onOuterAbort);
        if (error === stalled || (outer?.aborted === true && error === outer.reason)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not reach ${url}: ${reason}`);
    }
    async function readChunks(write: (chunk: Uint8Array) => Promise<void>): Promise<void> {
        if (response.body === null) return;
        const reader = response.body.getReader();
        try {
            while (true) {
                const chunk = await waitForProgress((async () => {
                    while (true) {
                        const next = await reader.read().catch((error: unknown) => {
                            throw controller.signal.aborted ? error : new Error(interruptedMessage(url, error));
                        });
                        if (next.done || next.value.byteLength > 0) return next;
                    }
                })());
                if (chunk.done) break;
                await write(chunk.value);
            }
        } catch (error) {
            controller.abort();
            void reader.cancel().catch(() => undefined);
            throw error;
        } finally {
            reader.releaseLock();
        }
    }
    async function readBody(): Promise<string> {
        const decoder = new TextDecoder();
        let text = "";
        await readChunks(async (chunk) => { text += decoder.decode(chunk, { stream: true }); });
        return text + decoder.decode();
    }
    try {
        return await consume(response, readBody, readChunks);
    } finally {
        outer?.removeEventListener("abort", onOuterAbort);
        controller.abort();
    }
}

// Bun appends a pointer to its verbose option to connection errors.
function interruptedMessage(url: string, error: unknown): string {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\. For more information.*$/s, "");
    return `Download of ${url} was interrupted: ${reason}`;
}

export async function fetchText(url: string, options: DownloadOptions): Promise<string> {
    return await fetchWithTimeout(url, options, { "user-agent": "vera-update" }, async (response, readBody) => {
        if (!response.ok) {
            throw new DownloadStatusError(url, response.status);
        }
        return await readBody();
    });
}

export async function downloadToFile(
    url: string,
    path: string,
    options: DownloadOptions,
): Promise<void> {
    await fetchWithTimeout(url, options, { "user-agent": "vera-update" }, async (response, _readBody, readChunks) => {
        if (!response.ok) {
            throw new DownloadStatusError(url, response.status);
        }
        if (response.body === null) {
            throw new Error(`Could not download ${url}: the response has no body.`);
        }
        const declared = Number(response.headers.get("content-length"));
        const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
        let bytes = 0;
        const file = await open(path, "w");
        try {
            await readChunks(async (chunk) => {
                await file.write(chunk);
                bytes += chunk.byteLength;
                options.onProgress?.({ url, bytes, total });
            });
        } finally {
            await file.close();
        }
        // A declared length is for the bytes as sent, so a compressed response cannot be compared to it.
        if (total !== undefined && bytes < total && response.headers.get("content-encoding") === null) {
            throw new Error(`Download of ${url} ended early: ${bytes} of ${total} bytes.`);
        }
    });
}

// Returns the sum the checksum file holds, which the file has just been shown to match.
export async function verifyChecksum(tarball: string, checksumFile: string, asset: string): Promise<string> {
    const expected = readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0] ?? "";
    if (!/^[0-9a-fA-F]{64}$/.test(expected)) {
        throw new Error(`Checksum file for ${asset} does not hold a SHA-256 sum.`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(tarball)) {
        hash.update(chunk as Buffer);
    }
    const actual = hash.digest("hex");
    if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Checksum mismatch for ${asset}.`);
    }
    return actual;
}
