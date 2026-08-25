import {
    readFreshProviderCatalogSnapshot,
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
    type ProviderCatalogCacheOptions,
} from "./catalog-cache.ts";
import type { CatalogModel, ProviderCatalog } from "./catalog-shape.ts";
import { providerEndpointUrl } from "../providers/endpoint-url.ts";

export interface OpenAIProviderDiscoveryOptions {
    readonly provider: string;
    readonly baseUrl: string;
    readonly credential?: "required" | "optional" | "none";
    readonly apiKey?: string;
    readonly endpoint?: string;
    readonly cacheDir?: string;
    readonly maxAgeMs?: number;
    readonly timeoutMs?: number;
    readonly fetch?: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
}

/** Generic authenticated/unauthenticated OpenAI-compatible `/models` ladder. */
export async function refreshOpenAIProviderCatalog(
    options: OpenAIProviderDiscoveryOptions,
): Promise<ProviderCatalog | undefined> {
    const cacheOptions: ProviderCatalogCacheOptions = options.cacheDir === undefined
        ? {}
        : { cacheDir: options.cacheDir };
    const fresh = readFreshProviderCatalogSnapshot(
        options.provider,
        options.maxAgeMs ?? 0,
        cacheOptions,
    );
    if (fresh !== undefined) return fresh;
    const endpoint = options.endpoint ?? providerEndpointUrl(options.baseUrl, "/models");
    try {
        const headers: Record<string, string> = {};
        if (options.apiKey !== undefined) {
            headers.authorization = `Bearer ${options.apiKey}`;
        }
        const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(options.timeoutMs ?? 2_500),
        });
        if (!response.ok) return staleCatalog(options.provider, cacheOptions);
        const catalog = normalizeOpenAIModels(options.provider, await response.json());
        if (catalog.models.length === 0) return staleCatalog(options.provider, cacheOptions);
        try {
            writeProviderCatalogSnapshot(catalog, cacheOptions);
        } catch {
            // The response is still useful even if the disposable snapshot is not.
        }
        return catalog;
    } catch {
        return staleCatalog(options.provider, cacheOptions);
    }
}

export function normalizeOpenAIModels(
    provider: string,
    raw: unknown,
): ProviderCatalog {
    const data = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
    const models: CatalogModel[] = data.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
            return [];
        }
        return [{
            id: entry.id,
            label: typeof entry.name === "string" ? entry.name : entry.id,
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            levels: [],
        }];
    });
    return {
        schema_version: 2,
        provider,
        fetched_at: new Date().toISOString(),
        models,
    };
}

function staleCatalog(
    provider: string,
    options: ProviderCatalogCacheOptions,
): ProviderCatalog | undefined {
    const cached = readProviderCatalogSnapshot(provider, options);
    return cached.models.length === 0 ? undefined : cached;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
