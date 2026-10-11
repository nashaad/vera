import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadExtensionManifest, realFileWithin } from "../extensions/manifest.ts";
import { extensionStorage } from "../extensions/storage.ts";
import { requestExtensionThroughHost } from "../host/extension-request-client.ts";
import type {
    VeraAnnexPageApi,
    VeraAnnexPageModule,
    VeraAnnexRouteHandler,
} from "../sdk/annex-pages.ts";
import type { JsonValue } from "../sdk/hooks.ts";
import { markdownBlocks } from "./markdown-blocks.ts";
import { exactRoute, prefixRoute, type AnnexRoute } from "./routes.ts";

const API_PATH_PATTERN = /^[a-z0-9][a-z0-9/_-]*$/i;
const HOST_REQUEST_TIMEOUT_MS = 30_000;

export interface ExtensionPageSummary {
    readonly extensionId: string;
    readonly pageId: string;
    readonly label: string;
    readonly href: string;
}

interface LoadedPage {
    readonly summary: ExtensionPageSummary;
    readonly browserPath: string;
    readonly handlers: ReadonlyMap<string, VeraAnnexRouteHandler>;
}

export interface ExtensionPageOptions {
    /** The host that spawned this annex. Without it, `page.host.request` rejects. */
    readonly hostSocketPath?: string;
    readonly log?: (message: string) => void;
}

export async function extensionPageRoutes(
    directories: readonly string[],
    html: string,
    options: ExtensionPageOptions = {},
): Promise<readonly AnnexRoute[]> {
    const log = options.log ?? ((message: string) => {
        process.stderr.write(`vera-annex: ${message}\n`);
    });
    const pages = new Map<string, LoadedPage>();
    for (const directory of directories) {
        for (const page of await loadPages(directory, options.hostSocketPath, log)) {
            pages.set(pageKey(page.summary.extensionId, page.summary.pageId), page);
        }
    }
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    return [
        exactRoute("/api/pages", () => Response.json(
            { pages: [...pages.values()].map((page) => page.summary) },
            { headers: { "cache-control": "no-store" } },
        )),
        prefixRoute("/x/", async ({ request, url }) => {
            const match = /^\/x\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
            const page = match === null
                ? undefined
                : pages.get(pageKey(decodeURIComponent(match[1] ?? ""), match[2] ?? ""));
            if (match === null || page === undefined) {
                return new Response("Not found", { status: 404 });
            }
            const rest = match[3] ?? "";
            if (rest === "") {
                return new Response(html, {
                    headers: { "content-type": "text/html; charset=utf-8" },
                });
            }
            if (rest === "page.js") {
                const source = await Bun.file(page.browserPath).text();
                return new Response(transpiler.transformSync(source), {
                    headers: {
                        "content-type": "text/javascript; charset=utf-8",
                        "cache-control": "no-store",
                    },
                });
            }
            if (!rest.startsWith("api/")) {
                return new Response("Not found", { status: 404 });
            }
            const handler = page.handlers.get(rest.slice("api/".length));
            if (handler === undefined) {
                return new Response("Not found", { status: 404 });
            }
            if (!isSafeMethod(request.method) && !isSameOrigin(request, url)) {
                return new Response("Forbidden", { status: 403 });
            }
            try {
                return await handler(request, url);
            } catch (error) {
                log(`${page.summary.extensionId}/${page.summary.pageId}: ${errorMessage(error)}`);
                return Response.json({ error: "page route failed" }, { status: 500 });
            }
        }),
    ];
}

async function loadPages(
    directory: string,
    hostSocketPath: string | undefined,
    log: (message: string) => void,
): Promise<readonly LoadedPage[]> {
    let manifest;
    try {
        manifest = loadExtensionManifest(directory);
    } catch (error) {
        log(`skipped extension pages in ${directory}: ${errorMessage(error)}`);
        return [];
    }
    const extensionId = manifest.manifest.id;
    const loaded: LoadedPage[] = [];
    for (const contribution of manifest.manifest.contributes.pages) {
        try {
            const serverPath = realFileWithin(
                manifest.directory,
                resolve(manifest.directory, contribution.server),
                "page module",
            );
            const browserPath = realFileWithin(
                manifest.directory,
                resolve(manifest.directory, contribution.browser),
                "page module",
            );
            const handlers = new Map<string, VeraAnnexRouteHandler>();
            const api: VeraAnnexPageApi = Object.freeze({
                extensionId,
                pageId: contribution.id,
                storage: extensionStorage(extensionId),
                route(path: string, handler: VeraAnnexRouteHandler): void {
                    if (!API_PATH_PATTERN.test(path) || path.split("/").includes("..")) {
                        throw new Error(`Invalid page route path: ${path}`);
                    }
                    handlers.set(path, handler);
                },
                markdownBlocks,
                host: Object.freeze({
                    async request(
                        name: string,
                        payload: JsonValue = null,
                        signal: AbortSignal = AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS),
                    ): Promise<JsonValue> {
                        if (hostSocketPath === undefined) {
                            throw new Error("This annex has no host to ask");
                        }
                        return requestExtensionThroughHost(hostSocketPath, extensionId, name, payload, signal);
                    },
                }),
            });
            const module = await import(pathToFileURL(serverPath).href) as Partial<VeraAnnexPageModule>;
            if (typeof module.activatePage !== "function") {
                throw new Error("page server module must export activatePage");
            }
            await module.activatePage(api);
            loaded.push({
                summary: {
                    extensionId,
                    pageId: contribution.id,
                    label: contribution.label,
                    href: `/x/${encodeURIComponent(extensionId)}/${contribution.id}`,
                },
                browserPath,
                handlers,
            });
        } catch (error) {
            log(`page ${extensionId}/${contribution.id} failed to load: ${errorMessage(error)}`);
        }
    }
    return loaded;
}

function pageKey(extensionId: string, pageId: string): string {
    return `${extensionId}\u0000${pageId}`;
}

function isSafeMethod(method: string): boolean {
    return method === "GET" || method === "HEAD";
}

// A loopback port is reachable from any tab, so writes must come from the page.
function isSameOrigin(request: Request, url: URL): boolean {
    const origin = request.headers.get("origin");
    if (origin !== null) return origin === url.origin;
    return request.headers.get("sec-fetch-site") === "same-origin";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
