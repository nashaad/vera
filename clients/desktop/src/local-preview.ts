import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

export const LOCAL_PREVIEW_SCHEME = "vera-preview";
export const MAX_PREVIEW_SCOPES = 12;
export const MAX_PREVIEW_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_READS = 16;
const STREAM_BUFFER_BYTES = 64 * 1024;
const PREVIEW_PERMISSIONS = "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), midi=(), payment=(), fullscreen=(), clipboard-read=(), clipboard-write=()";

const MIME: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".ico": "image/x-icon", ".avif": "image/avif", ".woff": "font/woff",
    ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
};

function refusal(status: number, message: string, head: boolean): Response {
    return new Response(head ? null : message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function within(root: string, path: string): boolean {
    const part = relative(root, path);
    return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

interface Scope {
    readonly root: string;
    readonly streams: Set<Readable>;
}

export class LocalPreviewScopes {
    private readonly scopes = new Map<string, Scope>();
    private reads = 0;
    private generation = 0;

    async create(root: string, entry: string): Promise<{ token: string; url: string }> {
        if (this.scopes.size >= MAX_PREVIEW_SCOPES) throw new Error("Too many previews are open.");
        const generation = this.generation;
        const realRoot = await realpath(root);
        if (!(await stat(realRoot)).isDirectory()) throw new Error("The preview folder is unavailable.");
        const realEntry = await realpath(entry);
        const entryInfo = await stat(realEntry);
        if (!within(realRoot, realEntry) || !entryInfo.isFile()) throw new Error("The file is outside the preview folder.");
        if (entryInfo.size > MAX_PREVIEW_ASSET_BYTES) throw new Error("This file is too large to preview.");
        if (generation !== this.generation) throw new Error("The preview was closed.");
        if (this.scopes.size >= MAX_PREVIEW_SCOPES) throw new Error("Too many previews are open.");
        const token = randomBytes(24).toString("hex");
        this.scopes.set(token, { root: realRoot, streams: new Set() });
        const pathname = relative(realRoot, realEntry).split(sep).map(encodeURIComponent).join("/");
        return { token, url: `${LOCAL_PREVIEW_SCHEME}://${token}/${pathname}` };
    }

    release(token: string): void {
        const scope = this.scopes.get(token);
        this.scopes.delete(token);
        for (const stream of scope?.streams ?? []) stream.destroy();
    }

    clear(): void {
        this.generation++;
        for (const token of this.scopes.keys()) this.release(token);
    }

    owns(url: string): boolean {
        try {
            const parsed = new URL(url);
            return parsed.protocol === `${LOCAL_PREVIEW_SCHEME}:` && !parsed.username && !parsed.password && !parsed.port && this.scopes.has(parsed.hostname);
        } catch {
            return false;
        }
    }

    async source(url: string): Promise<string | undefined> {
        try {
            const parsed = new URL(url);
            const scope = this.scopes.get(parsed.hostname);
            if (parsed.protocol !== `${LOCAL_PREVIEW_SCHEME}:` || scope === undefined || parsed.username || parsed.password || parsed.port) return undefined;
            const decoded = decodeURIComponent(parsed.pathname);
            if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
            const candidate = resolve(scope.root, `.${decoded}`);
            if (!within(scope.root, candidate)) return undefined;
            const path = await realpath(candidate);
            if (!within(scope.root, path) || this.scopes.get(parsed.hostname) !== scope) return undefined;
            return path;
        } catch {
            return undefined;
        }
    }

    async serve(request: Request): Promise<Response> {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
        if (this.reads >= MAX_PREVIEW_READS) return refusal(503, "The preview is busy. Try Reload again.", request.method === "HEAD");
        this.reads++;
        let handle: FileHandle | undefined;
        let streaming = false;
        try {
            const token = new URL(request.url).hostname;
            const scope = this.scopes.get(token);
            const path = await this.source(request.url);
            if (scope === undefined || path === undefined) return refusal(404, "This file is unavailable in the preview.", request.method === "HEAD");
            handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
            const [opened, current] = await Promise.all([handle.stat(), stat(path)]);
            if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) return refusal(404, "This file is unavailable in the preview.", request.method === "HEAD");
            if (opened.size > MAX_PREVIEW_ASSET_BYTES) return refusal(413, "This file is too large to preview.", request.method === "HEAD");
            if (await this.source(request.url) !== path || this.scopes.get(token) !== scope) return refusal(404, "This file is unavailable in the preview.", request.method === "HEAD");
            const headers = { "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream", "Content-Length": String(opened.size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Permissions-Policy": PREVIEW_PERMISSIONS };
            if (request.method === "HEAD" || opened.size === 0) return new Response(null, { status: 200, headers });
            const stream = handle.createReadStream({ start: 0, end: opened.size - 1, autoClose: true, highWaterMark: STREAM_BUFFER_BYTES });
            scope.streams.add(stream);
            stream.once("close", () => { scope.streams.delete(stream); this.reads--; });
            streaming = true;
            return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: STREAM_BUFFER_BYTES, size: (chunk: Buffer) => chunk.byteLength } }) as unknown as ReadableStream, { status: 200, headers });
        } catch {
            return refusal(404, "This file is unavailable in the preview.", request.method === "HEAD");
        } finally {
            if (!streaming) {
                await handle?.close().catch(() => undefined);
                this.reads--;
            }
        }
    }
}
