import { join } from "node:path";

import { packedAnnexRoot } from "../release/layout.ts";
import {
    dispatchAnnexRoute,
    exactRoute,
    prefixRoute,
    type AnnexRoute,
} from "./routes.ts";
import {
    foldUsageReport,
    foldUsageSessionDetail,
    isUsageWindowId,
    type UsageReport,
    type UsageWindowId,
} from "./usage-report.ts";

export interface AnnexServer {
    readonly url: string;
    readonly port: number;
    close(): Promise<void>;
}

export interface StartAnnexServerOptions {
    readonly sessionDirectory: string;
    readonly catalogCacheDir?: string;
    readonly reviewLogPath?: string;
    readonly webRoot?: string;
    readonly hostname?: string;
    readonly port?: number;
    readonly fold?: (window: UsageWindowId) => Promise<UsageReport>;
    /** Extra pages. Adding one must not require a change under src/host/. */
    readonly extraRoutes?: readonly AnnexRoute[];
}

interface PackedAnnexAssets {
    readonly html: string;
    readonly js: string;
    readonly css: string;
}

/**
 * Loopback HTTP for the annex. Binds 127.0.0.1 only. `/usage` is the first
 * page; later pages join the route table here, not in the host.
 */
export async function startAnnexServer(
    options: StartAnnexServerOptions,
): Promise<AnnexServer> {
    const hostname = options.hostname ?? "127.0.0.1";
    const webRoot = options.webRoot ?? packedAnnexRoot();
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
    const assets = await readPackedAnnexAssets(webRoot);
    const routes: AnnexRoute[] = [
        ...usageRoutes(options, assets, fold),
        ...(options.extraRoutes ?? []),
    ];
    const server = Bun.serve({
        hostname,
        port: options.port ?? 0,
        fetch(request) {
            return dispatchAnnexRoute(routes, request);
        },
    });
    return {
        url: `http://${hostname}:${server.port}/`,
        port: server.port,
        async close() {
            server.stop(true);
        },
    };
}

function usageRoutes(
    options: StartAnnexServerOptions,
    assets: PackedAnnexAssets,
    fold: (window: UsageWindowId) => Promise<UsageReport>,
): readonly AnnexRoute[] {
    return [
        exactRoute("/usage", () => new Response(assets.html, {
            headers: { "content-type": "text/html; charset=utf-8" },
        })),
        exactRoute("/main.js", () => new Response(assets.js, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
        })),
        exactRoute("/styles.css", () => new Response(assets.css, {
            headers: { "content-type": "text/css; charset=utf-8" },
        })),
        exactRoute("/api/usage", async ({ url }) => {
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
        }),
        prefixRoute("/api/usage/session/", async ({ url }) => {
            const sessionMatch = /^\/api\/usage\/session\/([^/]+)$/.exec(
                url.pathname,
            );
            if (sessionMatch === null) {
                return new Response("Not found", { status: 404 });
            }
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
        }),
    ];
}

async function readPackedAnnexAssets(webRoot: string): Promise<PackedAnnexAssets> {
    const html = await readPackedAsset(webRoot, "index.html");
    const js = await readPackedAsset(webRoot, "main.js");
    const css = await readPackedAsset(webRoot, "styles.css");
    return { html, js, css };
}

async function readPackedAsset(webRoot: string, name: string): Promise<string> {
    const path = join(webRoot, name);
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`Packed annex asset missing: ${path}`);
    }
    try {
        return await file.text();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Packed annex asset unreadable: ${path}: ${reason}`);
    }
}
