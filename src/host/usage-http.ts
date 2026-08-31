import { join } from "node:path";

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
 * Loopback HTTP for Vera web. Binds 127.0.0.1 only. The browser fetches
 * `/api/usage`; everything else is the overview app.
 */
export async function startUsageWebServer(
    options: StartUsageWebServerOptions,
): Promise<UsageWebServer> {
    const hostname = options.hostname ?? "127.0.0.1";
    const webRoot = options.webRoot ?? defaultWebRoot();
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
    const assets = await buildWebAssets(webRoot);
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

function defaultWebRoot(): string {
    return join(import.meta.dir, "../../clients/web");
}

async function buildWebAssets(webRoot: string): Promise<{
    readonly html: string;
    readonly js: string;
    readonly css: string;
}> {
    const html = await Bun.file(join(webRoot, "index.html")).text();
    const css = await Bun.file(join(webRoot, "styles.css")).text();
    const built = await Bun.build({
        entrypoints: [join(webRoot, "main.tsx")],
        target: "browser",
        format: "esm",
        minify: false,
    });
    if (!built.success) {
        const detail = built.logs.map((log) => String(log)).join("\n");
        throw new Error(`Vera web failed to bundle:\n${detail}`);
    }
    const script = built.outputs.find((output) =>
        output.path.endsWith(".js") || output.type === "entry-point"
    );
    if (script === undefined) {
        throw new Error("Vera web bundle produced no JavaScript");
    }
    return { html, js: await script.text(), css };
}
