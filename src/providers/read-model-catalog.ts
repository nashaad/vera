import type { ProviderCatalog } from "../model/catalog-shape.ts";

export function providerEndpointError(value: string): string | undefined {
    let url: URL;
    try { url = new URL(value); } catch { return "Not a valid URL"; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Endpoint is not HTTP or HTTPS";
    return undefined;
}

export interface ReadModelCatalogOptions {
    readonly provider: string;
    readonly baseUrl: string;
    readonly protocol: string;
    readonly apiKey?: string;
    readonly fetch?: typeof fetch;
    readonly normalize?: (body: unknown) => ProviderCatalog;
}

// Reading a catalog produces discovery only. Callers persist it after a successful save.
export async function readModelCatalog(options: ReadModelCatalogOptions): Promise<ProviderCatalog> {
    const invalid = providerEndpointError(options.baseUrl);
    if (invalid !== undefined) throw new Error(invalid);
    const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = options.protocol === "anthropic-messages"
        ? { "anthropic-version": "2023-06-01", ...(options.apiKey ? { "x-api-key": options.apiKey } : {}) }
        : options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
    const models = new Map<string, ProviderCatalog["models"][number]>();
    let next: string | undefined = endpoint;
    const pages = new Set<string>();
    while (next !== undefined) {
        if (pages.has(next)) throw new Error("The host repeated a catalog page");
        pages.add(next);
        let response: Response;
        try {
            response = await (options.fetch ?? fetch)(next, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
        } catch { throw new Error("No response from that host"); }
        if (!response.ok) throw new Error(`Catalog request returned HTTP ${response.status}`);
        let body: { data?: unknown; has_more?: boolean; last_id?: string };
        try { body = await response.json() as typeof body; } catch { throw new Error("The host returned an invalid model catalog"); }
        if (!Array.isArray(body.data)) throw new Error("The host returned an invalid model catalog");
        if (options.normalize !== undefined) {
            for (const model of options.normalize(body).models) models.set(model.id, model);
        } else for (const row of body.data) {
            if (typeof row?.id !== "string" || row.id.length === 0) continue;
            models.set(row.id, { id: row.id, label: typeof row.display_name === "string" ? row.display_name
                : typeof row.name === "string" ? row.name : row.id, levels: [] });
        }
        const following: string | undefined = options.protocol === "anthropic-messages" && body.has_more && body.last_id
            ? `${endpoint}?after_id=${encodeURIComponent(body.last_id)}` : undefined;
        if (following === next) throw new Error("The host repeated a catalog page");
        next = following;
    }
    return { schema_version: 2, provider: options.provider, endpoint, fetched_at: new Date().toISOString(), models: [...models.values()] };
}
