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
    readonly preserveEmpty?: boolean;
    readonly catalogLayers?: readonly string[];
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

export type ProviderCatalogFailure =
    | "authentication"
    | "unavailable"
    | "malformed_response"
    | "empty_response";

export interface FreshProviderCatalogResult {
    readonly status: "fresh";
    readonly catalog: ProviderCatalog;
}

export interface RefreshedProviderCatalogResult {
    readonly status: "refreshed";
    readonly catalog: ProviderCatalog;
}

export interface StaleProviderCatalogResult {
    readonly status: "stale";
    readonly catalog: ProviderCatalog;
    readonly failure: ProviderCatalogFailure;
}

export interface FailedProviderCatalogResult {
    readonly status: "failed";
    readonly failure: ProviderCatalogFailure;
}

export interface ProviderCatalogPersistenceFailure {
    readonly status: "persistence_failed";
    readonly catalog: ProviderCatalog;
}

export type ProviderCatalogRefreshResult =
    | FreshProviderCatalogResult
    | RefreshedProviderCatalogResult
    | StaleProviderCatalogResult
    | FailedProviderCatalogResult
    | ProviderCatalogPersistenceFailure;

export async function refreshOpenAIProviderCatalog(
    options: OpenAIProviderDiscoveryOptions,
): Promise<ProviderCatalogRefreshResult> {
    const cacheOptions: ProviderCatalogCacheOptions = options.cacheDir === undefined
        ? {}
        : { cacheDir: options.cacheDir };
    const endpoint = options.endpoint ?? providerEndpointUrl(options.baseUrl, "/models");
    const fresh = readFreshProviderCatalogSnapshot(
        options.provider,
        options.maxAgeMs ?? 0,
        cacheOptions,
        endpoint,
    );
    if (fresh !== undefined) return { status: "fresh", catalog: fresh };
    const headers: Record<string, string> = {};
    if (options.apiKey !== undefined) {
        headers.authorization = `Bearer ${options.apiKey}`;
    }
    let response: Response;
    try {
        response = await (options.fetch ?? globalThis.fetch)(endpoint, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(options.timeoutMs ?? 2_500),
        });
    } catch {
        return failedRefresh(options.provider, cacheOptions, "unavailable", endpoint);
    }
    if (!response.ok) {
        return failedRefresh(
            options.provider,
            cacheOptions,
            response.status === 401 || response.status === 403
                ? "authentication"
                : "unavailable",
            endpoint,
        );
    }
    let raw: unknown;
    try {
        raw = await response.json();
    } catch {
        return failedRefresh(
            options.provider,
            cacheOptions,
            "malformed_response",
            endpoint,
        );
    }
    if (!isRecord(raw) || !Array.isArray(raw.data)) {
        return failedRefresh(
            options.provider,
            cacheOptions,
            "malformed_response",
            endpoint,
        );
    }
    const catalog = {
        ...normalizeOpenAIModels(
            options.provider,
            raw,
            options.catalogLayers ?? [],
        ),
        endpoint,
    };
    if (raw.data.length > 0 && catalog.models.length === 0) {
        return failedRefresh(
            options.provider,
            cacheOptions,
            "malformed_response",
            endpoint,
        );
    }
    if (catalog.models.length === 0 && options.preserveEmpty !== true) {
        return failedRefresh(
            options.provider,
            cacheOptions,
            "empty_response",
            endpoint,
        );
    }
    try {
        writeProviderCatalogSnapshot(catalog, cacheOptions);
    } catch {
        return { status: "persistence_failed", catalog };
    }
    return { status: "refreshed", catalog };
}

export function normalizeOpenAIModels(
    provider: string,
    raw: unknown,
    layers: readonly string[] = [],
): ProviderCatalog {
    const data = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
    const models: CatalogModel[] = data.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
            return [];
        }
        const contextWindow = positiveNumber(
            entry.context_window
            ?? entry.max_model_len
            ?? (isRecord(entry.meta) ? entry.meta.n_ctx : undefined)
            ?? (layers.includes("cerebras-models") && isRecord(entry.limits)
                ? entry.limits.max_context_length
                : undefined),
        );
        return [{
            id: entry.id,
            label: typeof entry.name === "string" ? entry.name : entry.id,
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
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

function positiveNumber(value: unknown): number | undefined {
    return Number.isSafeInteger(value) && (value as number) > 0
        ? value as number
        : undefined;
}

function failedRefresh(
    provider: string,
    options: ProviderCatalogCacheOptions,
    failure: ProviderCatalogFailure,
    endpoint?: string,
): StaleProviderCatalogResult | FailedProviderCatalogResult {
    const cached = readProviderCatalogSnapshot(provider, options);
    if (
        cached.models.length === 0
        || (endpoint !== undefined && cached.endpoint !== endpoint)
    ) {
        return { status: "failed", failure };
    }
    return { status: "stale", catalog: cached, failure };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
