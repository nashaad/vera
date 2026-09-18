import { PROVIDER_NAMES, PROVIDER_ENV, searchProvider, type SearchFetch, type SearchProvider, type SearchResult } from "./providers.ts";
export type { SearchResult } from "./providers.ts";

export interface ProviderChoice { readonly id: SearchProvider; readonly enabled: boolean }
export interface SearchOutcome {
    readonly provider: SearchProvider;
    readonly results: readonly SearchResult[];
    readonly notices: readonly string[];
}
interface SearchOptions {
    readonly fetcher?: SearchFetch;
    readonly timeoutMs?: number;
    readonly attemptTimeoutMs?: number;
}
export function searchInput(queryInput: unknown, limitInput: unknown): { query: string; limit: number } {
    if (typeof queryInput !== "string" || !queryInput.trim()) throw new Error("web_search requires a non-empty query.");
    const query = queryInput.trim();
    if (query.length > 600 || query.split(/\s+/).length > 75) throw new Error("web_search query must be at most 600 characters and 75 words.");
    const limit = limitInput === undefined ? 5 : limitInput;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("web_search max_results must be an integer from 1 to 10.");
    return { query, limit };
}
export async function searchWeb(
    queryInput: unknown, limitInput: unknown, providers: readonly ProviderChoice[],
    keyFor: (provider: SearchProvider) => string | undefined, signal: AbortSignal,
    options: SearchOptions = {},
): Promise<SearchOutcome> {
    const { query, limit } = searchInput(queryInput, limitInput);
    if (signal.aborted) throw new Error("Web search cancelled.");
    const notices: string[] = [];
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    for (const provider of providers.filter((entry) => entry.enabled)) {
        if (signal.aborted) throw new Error("Web search cancelled.");
        const key = keyFor(provider.id)?.trim();
        if (provider.id !== "duckduckgo" && !key) {
            notices.push(`${PROVIDER_NAMES[provider.id]}: API key unavailable (${PROVIDER_ENV[provider.id]} or /search-providers).`);
            continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) { notices.push("Web search timed out."); break; }
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, controller.signal]);
        const timer = setTimeout(() => controller.abort(), Math.min(remaining, options.attemptTimeoutMs ?? 5_000));
        try {
            const results = await searchProvider(provider.id, query, limit, key, combined, options.fetcher);
            return { provider: provider.id, results, notices };
        } catch (error) {
            if (signal.aborted) throw new Error("Web search cancelled.");
            notices.push(controller.signal.aborted ? `${PROVIDER_NAMES[provider.id]} search timed out.`
                : error instanceof Error ? error.message : `${PROVIDER_NAMES[provider.id]} search failed.`);
        } finally { clearTimeout(timer); }
    }
    throw new Error(notices.length ? `Web search failed. ${notices.join(" ")}` : "No search providers enabled. Open /search-providers to configure search.");
}

export async function searchBrave(query: unknown, limit: unknown, key: string | undefined, signal: AbortSignal, options: SearchOptions = {}): Promise<readonly SearchResult[]> {
    searchInput(query, limit);
    if (!key?.trim()) throw new Error("Web search requires BRAVE_API_KEY or a saved Brave key in /search-providers.");
    return (await searchWeb(query, limit, [{ id: "brave", enabled: true }], () => key, signal,
        { ...options, attemptTimeoutMs: options.timeoutMs ?? 15_000 })).results;
}
export function formatSearchResults(results: readonly SearchResult[], provider: SearchProvider = "brave", notices: readonly string[] = []): string {
    return [
        `Provider: ${PROVIDER_NAMES[provider]}`,
        ...notices.map((notice) => `Fallback: ${notice}`),
        ...(results.length ? results.map((result, index) => `\n${index + 1}. ${result.title}\n   URL: ${result.url}\n   ${result.snippet}`) : ["No results found."]),
    ].join("\n");
}
