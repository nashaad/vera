import { createHash } from "node:crypto";

import { DESKTOP_ENGINE } from "../../clients/ui/src/extensions/manifest.ts";
import type { CatalogEntry } from "../../clients/desktop/src/extension-catalog/task-protocol.ts";

export const PALETTE = ["#07080a", "#deddd7", "#e8582a", "#6fe3d4", "#ff5f56"];

export function sha256Of(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

// One catalog entry as the catalog repository writes it; `extra` overrides or adds fields.
export function rawEntry(url: string, bytes: Buffer, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "crow.pack",
        name: "Crow Night",
        version: "1.0.0",
        kind: "theme",
        engine: DESKTOP_ENGINE,
        url,
        sha256: sha256Of(bytes),
        size: bytes.length,
        palette: PALETTE,
        withdrawn: false,
        ...extra,
    };
}

export function catalogBytes(extensions: readonly unknown[], format: unknown = 1): Buffer {
    return Buffer.from(JSON.stringify({ format, extensions }));
}

export function listed(entry: Record<string, unknown>): CatalogEntry {
    return entry as unknown as CatalogEntry;
}

export interface Route {
    readonly status?: number;
    readonly body?: Buffer | string;
    readonly headers?: Record<string, string>;
}

// A local http server that answers each path from a table. Stop it with `stop`.
export function serve(routes: () => Record<string, Route | undefined>): { readonly origin: string; readonly hits: string[]; readonly stop: () => void } {
    const hits: string[] = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
            const { pathname } = new URL(request.url);
            hits.push(pathname);
            const route = routes()[pathname];
            if (route === undefined) return new Response("missing", { status: 404 });
            return new Response(typeof route.body === "string" ? route.body : new Uint8Array(route.body ?? []), { status: route.status ?? 200, headers: route.headers });
        },
    });
    return { origin: `http://127.0.0.1:${server.port}`, hits, stop: () => void server.stop(true) };
}
