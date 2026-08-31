import { join } from "node:path";

import { packedWebRoot } from "../release/layout.ts";
import {
    foldUsageReport,
    foldUsageSessionDetail,
    isUsageWindowId,
    type UsageReport,
    type UsageWindowId,
} from "./usage-report.ts";

export interface UsageWebServer {
    readonly url: string;
    close(): Promise<void>;
}

export interface StartUsageWebServerOptions {
    readonly sessionDirectory: string;
    readonly catalogCacheDir?: string;
    readonly reviewLogPath?: string;
    readonly webRoot?: string;
    readonly hostname?: string;
    readonly port?: number;
    readonly fold?: (window: UsageWindowId) => Promise<UsageReport>;
}

/**
 * Loopback HTTP for the usage page. Binds 127.0.0.1 only. The browser fetches
 * `/api/usage`; everything else is the already-packed app.
 */
export async function startUsageWebServer(
    options: StartUsageWebServerOptions,
): Promise<UsageWebServer> {
    const hostname = options.hostname ?? "127.0.0.1";
    const webRoot = options.webRoot ?? packedWebRoot();
    const fold = options.fold ?? ((window) => foldUsageReport({
        sessionDirectory: options.sessionDirectory,
        window,
        ...(options.catalogCacheDir === undefined
            ? {}
            : { catalogCacheDir: options.catalogCacheDir }),
        ...(options.reviewLogPath === undefined
            ? {}
            : { reviewLogPath: options.reviewLogPath }),
    }));
    const assets = await readPackedWebAssets(webRoot);
    const server = Bun.serve({
        hostname,
        port: options.port ?? 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/api/usage") {
                const raw = url.searchParams.get("window") ?? "7d";
                if (!isUsageWindowId(raw)) {
                    return Response.json(
                        { error: "unknown window" },
                        { status: 400 },
                    );
                }
                const report = await fold(raw);
                return Response.json(report, {
                    headers: { "cache-control": "no-store" },
                });
            }
            const sessionMatch = /^\/api\/usage\/session\/([^/]+)$/.exec(
                url.pathname,
            );
            if (sessionMatch !== null) {
                const raw = url.searchParams.get("window") ?? "7d";
                if (!isUsageWindowId(raw)) {
                    return Response.json(
                        { error: "unknown window" },
                        { status: 400 },
                    );
                }
                const detail = await foldUsageSessionDetail({
                    sessionDirectory: options.sessionDirectory,
                    window: raw,
                    sessionId: decodeURIComponent(sessionMatch[1] ?? ""),
                    ...(options.catalogCacheDir === undefined
                        ? {}
                        : { catalogCacheDir: options.catalogCacheDir }),
                    ...(options.reviewLogPath === undefined
                        ? {}
                        : { reviewLogPath: options.reviewLogPath }),
                });
                if (detail === undefined) {
                    return Response.json(
                        { error: "unknown session" },
                        { status: 404 },
                    );
                }
                return Response.json(detail, {
                    headers: { "cache-control": "no-store" },
                });
            }
            if (url.pathname === "/" || url.pathname === "/index.html") {
                return new Response(assets.html, {
                    headers: { "content-type": "text/html; charset=utf-8" },
                });
            }
            if (url.pathname === "/main.js") {
                return new Response(assets.js, {
                    headers: {
                        "content-type": "text/javascript; charset=utf-8",
                    },
                });
            }
            if (url.pathname === "/styles.css") {
                return new Response(assets.css, {
                    headers: { "content-type": "text/css; charset=utf-8" },
                });
            }
            return new Response("Not found", { status: 404 });
        },
    });
    return {
        url: `http://${hostname}:${server.port}/`,
        async close() {
            server.stop(true);
        },
    };
}

async function readPackedWebAssets(webRoot: string): Promise<{
    readonly html: string;
    readonly js: string;
    readonly css: string;
}> {
    const html = await readPackedAsset(webRoot, "index.html");
    const js = await readPackedAsset(webRoot, "main.js");
    const css = await readPackedAsset(webRoot, "styles.css");
    return { html, js, css };
}

async function readPackedAsset(webRoot: string, name: string): Promise<string> {
    const path = join(webRoot, name);
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`Packed web asset missing: ${path}`);
    }
    try {
        return await file.text();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Packed web asset unreadable: ${path}: ${reason}`);
    }
}
